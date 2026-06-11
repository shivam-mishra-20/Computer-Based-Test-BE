/* Test how the production enroll endpoint reacts to different body/Content-Type
 * combos, to reproduce the app's "Unexpected token ... is not valid JSON". */
require('dotenv').config();
require('node:dns').setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const API = 'https://computer-based-test-be-production.up.railway.app';
const COURSE_ID = process.argv[2] || '6a1a742b40d9e886908d6cc3';

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const users = mongoose.connection.collection('users');
  // a Class 11 student NOT enrolled in this course
  const course = await mongoose.connection.collection('courses').findOne(
    { _id: new mongoose.Types.ObjectId(COURSE_ID) },
    { projection: { title: 1, classLevel: 1, isFree: 1, enrolledStudents: 1 } },
  );
  console.log('Course:', course ? { title: course.title, classLevel: course.classLevel, isFree: course.isFree, enrolled: (course.enrolledStudents||[]).length } : 'NOT FOUND');
  if (!course) { await mongoose.disconnect(); return; }

  const enrolledSet = new Set((course.enrolledStudents || []).map(String));
  const norm = (v) => String(v||'').replace(/^Class\s*/i,'').trim();
  const student = await users.findOne({
    role: 'student',
    classLevel: { $in: [course.classLevel, `Class ${norm(course.classLevel)}`, norm(course.classLevel)] },
    _id: { $nin: (course.enrolledStudents || []) },
  }, { projection: { email: 1, classLevel: 1 } });
  console.log('Test student:', student?.email, student?.classLevel, '(enrolled already:', student ? enrolledSet.has(String(student._id)) : 'n/a', ')');
  if (!student) { await mongoose.disconnect(); return; }

  const token = jwt.sign({ id: String(student._id), role: 'student' }, process.env.JWT_SECRET, { expiresIn: '10m' });

  const variants = [
    { label: 'no Content-Type, no body', headers: {} },
    { label: 'application/json + NO body (app default)', headers: { 'Content-Type': 'application/json' } },
    { label: 'application/json + empty-string body', headers: { 'Content-Type': 'application/json' }, body: '' },
  ];

  for (const v of variants) {
    try {
      const res = await fetch(`${API}/api/courses/${COURSE_ID}/enroll`, {
        method: 'POST',
        headers: { ...v.headers, Authorization: `Bearer ${token}` },
        ...(v.body !== undefined ? { body: v.body } : {}),
      });
      const text = await res.text();
      console.log(`\n[${v.label}] status=${res.status}`);
      console.log('  body:', text.slice(0, 200));
      // undo so the next variant tests a fresh enroll
      await mongoose.connection.collection('courses').updateOne({ _id: course._id }, { $pull: { enrolledStudents: student._id } });
      await mongoose.connection.collection('courseprogresses').deleteOne({ studentId: student._id, courseId: course._id });
    } catch (e) {
      console.log(`\n[${v.label}] FETCH ERROR:`, e.message);
    }
  }

  await mongoose.disconnect();
})().catch((e) => { console.error('failed:', e); process.exit(1); });
