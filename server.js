const express = require('express');
const path = require('path');
const admin = require('firebase-admin');

const app = express();

// ✅ Parse form posts
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));


// ✅ Initialize Firebase Admin (LOCAL / SIMPLE)
let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
} else {
  // optional local fallback (keep this file OUT of GitHub)
  serviceAccount = require('./serviceAccountKey.json');
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// -------------------------------------------
// Helpers
// -------------------------------------------
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(email);
}

async function geocodeZipWithGoogle(zip) {
  const key = process.env.GOOGLE_GEOCODING_API_KEY;
  if (!key) throw new Error('Missing GOOGLE_GEOCODING_API_KEY');

  const url =
    `https://maps.googleapis.com/maps/api/geocode/json` +
    `?address=${encodeURIComponent(zip + ', USA')}` +
    `&key=${encodeURIComponent(key)}`;

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Google Geocoding HTTP error: ${resp.status}`);

  const data = await resp.json();

  if (data.status !== 'OK' || !data.results?.length) {
    throw new Error(`Google Geocoding failed: ${data.status}`);
  }

  const r = data.results[0];
  const loc = r.geometry?.location;

  if (typeof loc?.lat !== 'number' || typeof loc?.lng !== 'number') {
    throw new Error('Invalid lat/lng from Google');
  }

  let userTown = '';
  let userState = '';

  for (const c of (r.address_components || [])) {
    const types = c.types || [];
    if (types.includes('locality')) userTown = c.long_name;
    if (types.includes('administrative_area_level_1')) userState = c.short_name;
  }

  if (!userTown) {
    for (const c of (r.address_components || [])) {
      const types = c.types || [];
      if (types.includes('postal_town')) userTown = c.long_name;
    }
  }

  return {
    latitude: loc.lat,
    longitude: loc.lng,
    userTown,
    userState
  };
}

// -------------------------------------------
// 🔁 Root redirect FIRST (SMS/install flow)
// -------------------------------------------
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  return res.redirect(302, '/go');
});

// -------------------------------------------
// 🏠 Homeowners landing page
// -------------------------------------------
app.get(['/homeowners', '/homeowners/'], (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  return res.sendFile(path.join(__dirname, 'homeowners.html'));
});

// -------------------------------------------
// 📝 Lead capture endpoint → SAVE into Firestore
// -------------------------------------------
app.post(['/lead', '/lead/'], async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');

  const publicUserName   = String(req.body.name || '').trim();
  const publicUserEmail  = String(req.body.email || '').trim().toLowerCase();
  const rawPhone         = String(req.body.phone || '').trim();
  const projectText      = String(req.body.project || '').trim();
  const zip              = String(req.body.zip || '').trim();

  // ✅ Optional checkboxes
  const readyToHire      = req.body.readyToHire === 'yes';
  const urgent           = req.body.urgent === 'yes';

  // ✅ Optional budget (stored as Firestore number)
  const rawBudget = String(req.body.budgetText || '').trim();
  const budgetDigits = rawBudget ? rawBudget.replace(/\D/g, '') : '';
  const budgetNumber = budgetDigits ? parseInt(budgetDigits, 10) : null;

  // Consent
  const publicUserConcent = req.body.concent === 'yes';

  // Required checks
  if (!publicUserName || !publicUserEmail || !projectText || !zip) {
    return res.status(400).type('html').send(`
      <h2>Missing information</h2>
      <p>Please provide name, email, ZIP code, and project description.</p>
      <p><a href="/homeowners">Back to form</a></p>
    `);
  }

  // Email format check
  if (!isValidEmail(publicUserEmail)) {
    return res.status(400).type('html').send(`
      <h2>Email format</h2>
      <p>Please enter a valid email address (example: <b>name@email.com</b>).</p>
      <p><a href="/homeowners">Back to form</a></p>
    `);
  }

  if (!publicUserConcent) {
    return res.status(400).type('html').send(`
      <h2>Consent required</h2>
      <p>Please check the consent box to submit your request.</p>
      <p><a href="/homeowners">Back to form</a></p>
    `);
  }

  // ZIP: 5 digits
  if (!/^\d{5}$/.test(zip)) {
    return res.status(400).type('html').send(`
      <h2>ZIP code format</h2>
      <p>Please enter a 5-digit ZIP code (example: <b>06119</b>).</p>
      <p><a href="/homeowners">Back to form</a></p>
    `);
  }

  // Phone optional, but if provided must be E.164
  let publicUserPhone = '';
  if (rawPhone) {
    const e164 = /^\+[1-9]\d{9,14}$/;
    if (!e164.test(rawPhone)) {
      return res.status(400).type('html').send(`
        <h2>Phone number format</h2>
        <p>If you add a phone number, please use this format:</p>
        <p><b>+18885551234</b></p>
        <p><a href="/homeowners">Back to form</a></p>
      `);
    }
    publicUserPhone = rawPhone;
  }

  // Budget optional, but if provided must be a valid number
  if (rawBudget && (!budgetDigits || isNaN(budgetNumber) || budgetNumber < 0)) {
    return res.status(400).type('html').send(`
      <h2>Budget format</h2>
      <p>If you add a budget, please use numbers only (example: <b>2500</b>).</p>
      <p><a href="/homeowners">Back to form</a></p>
    `);
  }

  try {
    // 1) Google geocode ZIP
    const geo = await geocodeZipWithGoogle(zip);

    // 2) Create ONE UID used for BOTH collections
    const publicDocRef = db.collection('PublicUserInfo').doc();
    const publicUserUID = publicDocRef.id;
    const locationDocRef = db.collection('UserLocation').doc(publicUserUID);

    // 3) Batch write (atomic)
    const batch = db.batch();

    batch.set(publicDocRef, {
      publicUserUID,
      publicUserName,
      publicUserEmail,
      publicUserPhone,
      projectText,

      budgetText: budgetNumber, // ✅ Firestore number (or null)
      readyToHire,
      urgent,

      publicUserConcent,
      postedDate: admin.firestore.FieldValue.serverTimestamp(),
    });

    batch.set(locationDocRef, {
      uid: publicUserUID,
      name: publicUserName,
      contractor: false,
      latitude: geo.latitude,
      longitude: geo.longitude,
      altitude: 0,
      userState: geo.userState || '',
      userTown: geo.userTown || '',
      zipcode: zip,
      postedDate: admin.firestore.FieldValue.serverTimestamp(),
    });

    await batch.commit();

    return res.type('html').send(`
      <h2>Thanks! Your project was submitted.</h2>
      <p>Location saved for ZIP <b>${zip}</b>.</p>
      <p>Reference: <b>${publicUserUID}</b></p>
      <p><a href="/homeowners">Submit another request</a></p>
    `);
  } catch (err) {
    console.error('Lead save/geocode failed:', err);
    return res.status(500).type('html').send(`
      <h2>Sorry — we could not save your request.</h2>
      <p>Please try again.</p>
      <p><a href="/homeowners">Back to form</a></p>
    `);
  }
});

// -------------------------------------------
// Serve static files AFTER routes
// -------------------------------------------
app.use(express.static(__dirname, { extensions: ['html'] }));

// -------------------------------------------
// /download route
// -------------------------------------------
app.get(['/download', '/download/'], (req, res) => {
  const ua = String(req.headers['user-agent'] || '').toLowerCase();
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');

  const IOS_HTTPS = 'https://apps.apple.com/us/app/hoyalist/id6740706168';
  const AND_HTTPS = 'https://play.google.com/store/apps/details?id=com.hoyalist.hoyalist';

  if (ua.includes('android')) return res.redirect(302, AND_HTTPS);
  if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ipod')) return res.redirect(302, IOS_HTTPS);
  return res.redirect(302, 'https://hoyalistapp.com');
});

// -------------------------------------------
// /go route
// -------------------------------------------
app.get(['/go', '/go/'], (req, res) => {
  const ua = String(req.headers['user-agent'] || '');
  const ual = ua.toLowerCase();

  const PKG = 'com.hoyalist.hoyalist';
  const AND_HTTPS = `https://play.google.com/store/apps/details?id=${PKG}`;
  const IOS_HTTPS = 'https://apps.apple.com/us/app/hoyalist/id6740706168';

  const AND_INTENT =
    `intent://details?id=${PKG}` +
    `#Intent;scheme=market;package=com.android.vending;` +
    `S.browser_fallback_url=${encodeURIComponent(AND_HTTPS)};end;`;

  const IOS_ITMS = 'itms-apps://itunes.apple.com/app/id6740706168';

  const isAndroid = ual.includes('android');
  const isIOS = ual.includes('iphone') || ual.includes('ipad') || ual.includes('ipod');

  const isInApp =
    ual.includes('fban') || ual.includes('fbav') || ual.includes('facebook') ||
    ual.includes('instagram') || ual.includes('tiktok') ||
    ual.includes('twitter') || ual.includes('snapchat') ||
    ual.includes('pinterest') || ual.includes('gsa');

  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');

  if (isAndroid) {
    if (!isInApp) return res.redirect(302, AND_INTENT);
    return res.redirect(302, AND_HTTPS);
  }
  if (isIOS) {
    if (!isInApp) return res.redirect(302, IOS_ITMS);
    return res.redirect(302, IOS_HTTPS);
  }

  return res.redirect(302, 'https://hoyalistapp.com');
});

// -------------------------------------------
// Health check
// -------------------------------------------
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ HoyaList server running on port ${PORT}`));
