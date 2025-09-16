# CBT Backend API Implementation Guide

This document describes all available API endpoints, authentication/roles, data models, and recommended frontend flows for building a consistent UI that works with this backend.

Base URL: `http://localhost:5000`

Auth: All protected routes require an `Authorization: Bearer <JWT>` header.

---

## 1. Authentication

### POST /api/auth/register

- Public
- Body

```
{
  "name": "John Doe",
  "email": "john@example.com",
  "password": "Pass@123"
}
```

- Response

```
{
  "token": "<jwt>",
  "user": { "id": "...", "name": "John Doe", "email": "john@example.com", "role": "student" }
}
```

### POST /api/auth/login

- Public
- Body

```
{ "email": "admin@cbt.local", "password": "Admin@123" }
```

- Response: same shape as register

Notes

- Default admin can be seeded by env vars: `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME`.
- JWT secret from `JWT_SECRET`.

---

## 2. Users (Admin only)

### GET /api/users/dashboard

- Role: admin
- Summary: aggregate counts by role
- Response

```
{ "stats": { "admins": 1, "teachers": 3, "students": 120 } }
```

### POST /api/users

- Role: admin
- Body

```
{ "name": "Alice", "email": "alice@example.com", "password": "Pass@123", "role": "teacher" }
```

- Response

```
{ "id": "...", "name": "Alice", "email": "alice@example.com", "role": "teacher" }
```

### GET /api/users?role=student|teacher|admin

- Role: admin
- Response: Array of users (without password)

### GET /api/users/:id

- Role: admin

### PUT /api/users/:id

- Role: admin
- Body: any of `name`, `email`, `role`, `password`

### DELETE /api/users/:id

- Role: admin

---

## 3. Questions & Exams (Teacher/Admin)

### POST /api/exams/questions

- Role: teacher|admin
- Body (partial IQuestion):

```
{
  "text": "2+2= ?",
  "type": "mcq", // mcq | truefalse | fill | short | long
  "options": [
    { "text": "3", "isCorrect": false },
    { "text": "4", "isCorrect": true },
    { "text": "5", "isCorrect": false },
    { "text": "6", "isCorrect": false }
  ],
  "tags": { "subject": "Math", "topic": "Arithmetic", "difficulty": "easy" },
  "explanation": "Basic addition."
}
```

- Response: created question

### GET /api/exams/questions

- Role: teacher|admin
- Query: `q`, `subject`, `topic`, `difficulty`, `limit`, `skip`
- Response: `{ items: IQuestion[], total }`

### PUT /api/exams/questions/:id

- Role: teacher|admin

### DELETE /api/exams/questions/:id

- Role: teacher|admin

### POST /api/exams

- Role: teacher|admin
- Body (partial IExam):

```
{
  "title": "Algebra Unit Test",
  "description": "Basics of Algebra",
  "mode": "live", // practice | live | adaptive (default live)
  "totalDurationMins": 60,
  "sections": [
    {
      "title": "Section A",
      "questionIds": ["<questionId1>", "<questionId2>"] ,
      "sectionDurationMins": 30,
      "shuffleQuestions": true,
      "shuffleOptions": true
    }
  ],
  "isPublished": true,
  "assignedTo": { "users": ["<studentId>"] }
}
```

- Response: created exam

### GET /api/exams

- Role: teacher|admin
- Query: `title`, `createdBy`, `isPublished`, `limit`, `skip`

### GET /api/exams/:id

- Role: teacher|admin

### PUT /api/exams/:id

- Role: teacher|admin

### DELETE /api/exams/:id

- Role: teacher|admin

### POST /api/exams/:id/assign

- Role: teacher|admin
- Body

```
{ "users": ["<studentId1>", "<studentId2>"], "groups": ["Batch A"] }
```

---

## 4. Attempts (Student)

### GET /api/attempts/assigned

- Role: student
- Returns published or in-window exams assigned to the student.

### POST /api/attempts/:examId/start

- Role: student
- Creates an Attempt for this exam and student (if not existing), sets mode from Exam, and creates a randomized snapshot.
- Response: Attempt document

### GET /api/attempts/:attemptId

- Role: student
- Returns view with:

```
{
  "attempt": { ... },
  "exam": { "_id", "title", "totalDurationMins" },
  "sections": [ { _id, title, sectionDurationMins, questionIds: ObjectId[] } ],
  "questions": {
    "<questionId>": {
      "_id", "text", "type", "options": [ { _id, text } ],
      "tags": { subject, topic, difficulty },
      // In practice mode only and only for answered questions:
      "explanation": "..."
    }
  }
}
```

### POST /api/attempts/:attemptId/answer

- Role: student
- Body (one of chosenOptionId or textAnswer depending on type)

```
{
  "questionId": "<questionId>",
  "chosenOptionId": "<optionId>", // for mcq/truefalse
  "textAnswer": "...", // for fill/short/long
  "isMarkedForReview": false,
  "timeSpentSec": 25
}
```

- Live mode: Backend enforces `totalDurationMins`. If time is over, this call auto-submits and returns the submitted Attempt.

### POST /api/attempts/:attemptId/mark

- Role: student
- Body: `{ "questionId": "<id>", "marked": true }`

### POST /api/attempts/:attemptId/submit

- Role: student
- Body: `{ "auto": false }` (optional)
- Grades objective questions and (if AI configured) grades subjective questions via Groq. Live mode forces auto submit if time is up.
- Response: updated Attempt

### POST /api/attempts/:attemptId/log

- Role: student
- Body: `{ "type": "focus-lost" | "fullscreen-exit" | "suspicious" | "navigation", "meta": {...} }`

### POST /api/attempts/:attemptId/next (Adaptive)

- Role: student
- Returns next question for adaptive attempts:

```
{ "questionId": "<id>" } | { "done": true }
```

### GET /api/attempts/:attemptId/questions/:questionId/explanation

- Role: student
- Practice mode only; returns explanation for a question after it has been answered by the student:

```
{ "explanation": "..." } | { "explanation": null }
```

---

## 5. AI Features (Teacher/Admin)

### POST /api/ai/generate/pdf

- Role: teacher|admin
- Upload: `multipart/form-data` with file field `pdf` (<= 30MB) and optional text fields: `subject`, `topic`, `difficulty`, `count`.
- Response: `{ items: Question[], total }`
- Requires `GOOGLE_API_KEY`/`GEMINI_API_KEY` env.

### POST /api/ai/generate/text

- Role: teacher|admin
- Body

```
{
  "text": "<long source text>",
  "subject": "Physics",
  "topic": "Kinematics",
  "difficulty": "medium",
  "count": 10
}
```

- Response: `{ items: Question[], total }`

### POST /api/ai/evaluate/subjective

- Role: teacher|admin
- Body

```
{ "questionText": "...", "studentAnswer": "...", "rubric": "..." }
```

- Response: `{ rubricScore: 0..1, feedback: string }`
- Requires `GROQ_API_KEY` env.

---

## 6. Analytics

### GET /api/analytics/me/progress

- Role: student
- Response: array of attempts with `{ submittedAt, totalScore, maxScore, percent, examTitle }`

### GET /api/analytics/exams/:examId/insights

- Role: teacher|admin
- Response

```
{
  "topicCount": { "TopicA": 4, ... },
  "difficultyCount": { "easy": 3, "medium": 10, "hard": 2 },
  "topicAvg": { "TopicA": 0.6, ... }
}
```

---

## 7. Reports (Teacher/Admin)

### GET /api/reports/exams/:examId/attendance

- Role: teacher|admin
- Response: `{ count, attended: [ { userId, startedAt, submittedAt, status } ] }`

### GET /api/reports/exams/:examId/logs

- Role: teacher|admin
- Response: attempts with `activityLogs`

### GET /api/reports/exams/:examId/results.csv

- Role: teacher|admin
- Downloads a CSV of results

---

## 8. Modes Summary

- practice
  - Explanations are shown after a question is answered (in attempt view or via explanation endpoint).
  - Timer is soft (not enforced by backend unless you decide to add it later).
- live
  - Strict timer: `saveAnswer` auto-submits when time is over; `submitAttempt` treats overdue as auto submit.
  - Explanations hidden until results.
- adaptive
  - Use `POST /api/attempts/:attemptId/next` to fetch the next question based on difficulty progression.

---

## 9. Frontend Integration Tips

- Auth
  - Store token securely (memory or httpOnly cookie proxy). Attach `Authorization: Bearer <token>` to protected calls.
- Roles
  - Frontend can read user.role from login response to conditionally render teacher/admin/student features.
- Attempt Timer (live mode)
  - Compute remaining time on client using `attempt.startedAt` and `exam.totalDurationMins`. Handle the case where `saveAnswer` returns a submitted attempt due to time over.
- Practice Hints
  - In attempt view, check if `question.explanation` exists. Or call the explanation endpoint when the student submits an answer to that question.
- Adaptive Flow
  - After student answers the current question, call `POST /api/attempts/:attemptId/next`. If `{ done: true }`, show submit.
- AI Costs/Errors
  - If AI keys are missing, endpoints will respond with errors. Show a friendly message. Objective grading still works.
- IDs
  - Many endpoints require ObjectIds. Fetch `/api/exams` to list and pick the correct `examId`.

---

## 10. Environment Variables

- Required (core):
  - `MONGO_URI`, `JWT_SECRET`
- Optional (AI):
  - `GOOGLE_API_KEY` or `GEMINI_API_KEY` (Gemini)
  - `GROQ_API_KEY` (Groq)
- Optional (seeding admin):
  - `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME`

---

## 11. Error Handling Conventions

- 401 Unauthorized: Missing/invalid token
- 403 Forbidden: Insufficient role or accessing another user's attempt
- 404 Not Found: Resource not found
- 400 Bad Request: Validation or casting errors (e.g., invalid ObjectId)
- 500 Server Error: Unhandled exception (see server logs)

---

## 12. Postman Collection

A ready-to-import collection is in `postman/CBT-Backend.postman_collection.json` with examples for auth, AI, attempts, adaptive next question, and analytics. Set `{{baseUrl}}`, `{{token}}`, `{{examId}}`, and `{{attemptId}}` variables.
