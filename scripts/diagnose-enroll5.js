/* Verify enroll works with NO Content-Type header (the fixed app behavior)
 * and also probe the LOCAL dev backend if it is running on :5000. */
require('dotenv').config();
require('node:dns').setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const PROD = 'https://computer-based-test-be-production.up.railway.app';
const LOCAL = 'http://localhost:5000';
const COURSE_ID = '69f460320ffbafa5a90409d3'; // real Class 11 free course

async function hit(api, token, label, withCT) {
  const headers = { Authorization: `Bearer ${token}` };
  if (withCT) headers['Content-Type'] = 'application/json';
  try {
    const res = await fetch(`${api}/api/courses/${COURSE_ID}/enroll`, { method: 'POST', headers });
    const text = await res.text();
    console.log(`[${label}] status=${res.status} ct=${res.headers.get('content-type')}`);
    console.log('   body:', text.slice(0, 160));
  } catch (e) {
    console.log(`[${label}] no response (${e.cause?.code || e.message})`);
  }
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const u = await mongoose.connection.collection('users').findOne({ role: 'student', classLevel: 'Class 11' }, { projection: { _id: 1 } });
  const token = jwt.sign({ id: String(u._id), role: 'student' }, process.env.JWT_SECRET, { expiresIn: '10m' });

  // cleanup helper so repeated runs aren't blocked by "already enrolled"
  const clean = async () => {
    await mongoose.connection.collection('courses').updateOne({ _id: new mongoose.Types.ObjectId(COURSE_ID) }, { $pull: { enrolledStudents: u._id } });
    await mongoose.connection.collection('courseprogresses').deleteOne({ studentId: u._id, courseId: new mongoose.Types.ObjectId(COURSE_ID) });
  };

  await clean();
  await hit(PROD, token, 'PROD  WITH    Content-Type', true);
  await clean();
  await hit(PROD, token, 'PROD  WITHOUT Content-Type', false);
  await clean();
  await hit(LOCAL, token, 'LOCAL WITH    Content-Type', true);
  await clean();
  await hit(LOCAL, token, 'LOCAL WITHOUT Content-Type', false);
  await clean();

  await mongoose.disconnect();
})().catch((e) => { console.error('failed:', e); process.exit(1); });
