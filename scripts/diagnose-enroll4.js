require('dotenv').config();
require('node:dns').setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const API = 'https://computer-based-test-be-production.up.railway.app';
const COURSE_ID = process.argv[2] || '6a1a742b40d9e886908d6cc3';

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const users = mongoose.connection.collection('users');
  const student = await users.findOne({ role: 'student', classLevel: 'Class 11' }, { projection: { email: 1 } });
  const token = jwt.sign({ id: String(student._id), role: 'student' }, process.env.JWT_SECRET, { expiresIn: '10m' });
  await mongoose.disconnect();

  // Exactly mimic the app: POST, Content-Type application/json, NO body
  const res = await fetch(`${API}/api/courses/${COURSE_ID}/enroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  });
  console.log('status:', res.status);
  console.log('content-type:', res.headers.get('content-type'));
  const text = await res.text();
  console.log('raw body:', JSON.stringify(text.slice(0, 300)));
})().catch((e) => { console.error('failed:', e); process.exit(1); });
