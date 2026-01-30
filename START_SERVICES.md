# 🚀 Quick Start Guide - Running Everything Together

## Prerequisites
- Node.js installed (v18+)
- MongoDB running (local or Atlas)
- All dependencies installed

---

## 📦 One-Time Setup

### 1. Install Backend Dependencies
```powershell
cd C:\Users\Shivam\cbt-exam-be
npm install
npm install jszip xml2js cheerio axios node-cron
```

### 2. Install Frontend Dependencies
```powershell
cd C:\Users\Shivam\cbt-exam
npm install
```

### 3. Configure Environment Variables

**Backend** (`cbt-exam-be/.env`):
```env
PORT=5000
MONGODB_URI=your-mongodb-connection-string
JWT_SECRET=your-jwt-secret
FIREBASE_STORAGE_BUCKET=your-bucket.appspot.com

# Optional: Google Cloud for AI enhancement
GOOGLE_CLOUD_PROJECT=your-project
GOOGLE_APPLICATION_CREDENTIALS=./vision-key.json
```

**Frontend** (`cbt-exam/.env.local`):
```env
NEXT_PUBLIC_API_URL=http://localhost:5000
```

---

## ▶️ Starting Services (3 Terminals)

### Terminal 1: Backend Server
```powershell
cd C:\Users\Shivam\cbt-exam-be
npm start
```
**Output:**
```
✓ Server running on port 5000
✓ MongoDB connected successfully
✓ Automation scheduler initialized
```

### Terminal 2: Frontend Server
```powershell
cd C:\Users\Shivam\cbt-exam
npm run dev
```
**Output:**
```
- ready started server on 0.0.0.0:3000, url: http://localhost:3000
✓ Compiled successfully
```

### Terminal 3: Test Automation (Optional)
```powershell
cd C:\Users\Shivam\cbt-exam-be

# Test EPUB parser
node scripts/epub-parser.js "class_12/NEET JEE Chemistry Practice Bank Part 1 (5000+ Questions).epub"

# OR run automation manually
node scripts/automation-runner.js
```

---

## 🌐 Access Points

### Frontend Dashboard
```
http://localhost:3000
```
- Login as admin
- Navigate to: **Admin Dashboard → EPUB Automation**

### Backend API
```
http://localhost:5000
```
- Health check: `http://localhost:5000/api/health`
- Automation status: `http://localhost:5000/api/automation/status`

### API Documentation
```
http://localhost:5000/
```
Shows all available endpoints

---

## 🎯 Complete Startup Workflow

### Option A: Using VS Code (Recommended)

1. **Open VS Code**
   - Open both projects in workspace

2. **Split Terminal (3 panels)**
   - Terminal → Split Terminal (do this twice)

3. **Start Services:**
   ```powershell
   # Terminal 1 (Backend)
   cd C:\Users\Shivam\cbt-exam-be; npm start

   # Terminal 2 (Frontend)
   cd C:\Users\Shivam\cbt-exam; npm run dev

   # Terminal 3 (Commands)
   cd C:\Users\Shivam\cbt-exam-be
   ```

### Option B: Using Batch Script (Easiest)

**Create**: `start-all.bat` in `cbt-exam-be` folder
```batch
@echo off
echo Starting CBT Exam System...
echo.

echo [1/2] Starting Backend Server...
start "Backend" cmd /k "cd /d C:\Users\Shivam\cbt-exam-be && npm start"
timeout /t 5

echo [2/2] Starting Frontend Server...
start "Frontend" cmd /k "cd /d C:\Users\Shivam\cbt-exam && npm run dev"

echo.
echo ✓ All services started!
echo.
echo Backend:  http://localhost:5000
echo Frontend: http://localhost:3000
echo.
echo Press any key to view logs...
pause
```

**Run**:
```powershell
.\start-all.bat
```

### Option C: Using npm-run-all (Advanced)

**Install**:
```powershell
cd C:\Users\Shivam\cbt-exam-be
npm install -D npm-run-all concurrently
```

**Update `package.json`**:
```json
{
  "scripts": {
    "start": "node src/index.js",
    "dev:all": "concurrently \"npm start\" \"cd ../cbt-exam && npm run dev\""
  }
}
```

**Run**:
```powershell
npm run dev:all
```

---

## ✅ Verification Checklist

### Backend Running?
```powershell
curl http://localhost:5000/api/health
```
**Expected**: `{"status":"healthy","timestamp":"...","uptime":...}`

### Frontend Running?
```powershell
curl http://localhost:3000
```
**Expected**: HTML response (Next.js page)

### Database Connected?
Check backend terminal output:
```
✓ MongoDB connected successfully
```

### Automation Ready?
```powershell
curl http://localhost:5000/api/automation/status -H "Authorization: Bearer YOUR_TOKEN"
```
**Expected**: `{"success":true,"status":{...}}`

---

## 🔧 Configuration & Setup

### 1. Login as Admin
```
http://localhost:3000/login
```
Use your admin credentials

### 2. Access Automation Dashboard
```
http://localhost:3000/dashboard/admin?tab=automation
```

### 3. Configure Schedule
- Click **"Configure Schedule"** button
- Set your preferred time (e.g., 3:00 PM)
- Select days of week
- Click **"Save Schedule"**

### 4. Enable Automation
- Click **"Enable"** toggle
- Status should change to: ✅ ENABLED

### 5. Test Manual Run
- Click **"Run Now"** button
- Watch the processing stats update in real-time

---

## 📊 Dynamic Scheduling (No More Fixed 2 PM!)

### How It Works:
1. **Admin sets schedule** via dashboard (any time, any day)
2. **Backend uses node-cron** to run automatically
3. **Schedule persists** in MongoDB (survives restarts)
4. **Can be changed anytime** without code changes

### Schedule Options:
- **Time**: Any hour:minute (e.g., 3:30 PM)
- **Days**: Select specific days (Mon, Tue, Wed, etc.)
- **Frequency**: Daily, weekdays, weekends, or custom
- **Timezone**: Automatically uses server timezone

### Example Schedules:
```
Daily at 2:00 PM         → "0 14 * * *"
Weekdays at 9:00 AM      → "0 9 * * 1-5"
Mon/Wed/Fri at 6:00 PM   → "0 18 * * 1,3,5"
Every 6 hours            → "0 */6 * * *"
```

---

## 🛑 Stopping Services

### Stop All (Ctrl+C in each terminal)
```
Terminal 1: Ctrl+C  (Backend)
Terminal 2: Ctrl+C  (Frontend)
```

### Or Kill Processes
```powershell
# Find processes
Get-Process node

# Kill by port
Stop-Process -Id (Get-NetTCPConnection -LocalPort 5000).OwningProcess -Force
Stop-Process -Id (Get-NetTCPConnection -LocalPort 3000).OwningProcess -Force
```

---

## 🐛 Troubleshooting

### Port Already in Use
```powershell
# Check what's using port 5000
netstat -ano | findstr :5000

# Kill the process
taskkill /PID <PID> /F
```

### MongoDB Connection Failed
- Check MongoDB is running: `mongosh`
- Verify connection string in `.env`
- Check firewall settings

### Frontend Can't Connect to Backend
- Verify backend is running on port 5000
- Check CORS configuration in `app.ts`
- Verify `NEXT_PUBLIC_API_URL` in frontend `.env.local`

### Automation Not Running
- Check automation is **ENABLED** in dashboard
- Verify schedule is configured
- Check backend logs for errors
- Ensure EPUB files exist in `class_12/` folder

---

## 📱 Mobile Development (Bonus)

If you also want to run the mobile app:

### Terminal 4: Expo App
```powershell
cd C:\Users\Shivam\abhigyan-gurukul-app
npx expo start
```

---

## 🎉 Success!

Once all services are running, you should see:

✅ **Backend**: `http://localhost:5000` (API working)  
✅ **Frontend**: `http://localhost:3000` (Dashboard accessible)  
✅ **Automation**: Schedule configured, ready to run  
✅ **EPUB Processing**: Can trigger manually or automatically  

---

## 💡 Pro Tips

### 1. Keep Terminals Open
Don't close terminal windows while services are running

### 2. Monitor Logs
Watch backend terminal for automation events:
```
[14:00:00] Automation triggered (scheduled)
[14:00:01] Scanning class_12/ folder...
[14:00:02] Found 1 EPUB file
[14:00:03] Processing: NEET JEE Chemistry...
```

### 3. Use PM2 for Production
```powershell
npm install -g pm2
pm2 start src/index.js --name cbt-backend
pm2 start npm --name cbt-frontend -- run dev
pm2 logs
```

### 4. Restart After Code Changes
- Backend: Stop (Ctrl+C) and `npm start` again
- Frontend: Next.js auto-reloads in dev mode

---

## 📞 Quick Commands Reference

```powershell
# Start backend
cd C:\Users\Shivam\cbt-exam-be && npm start

# Start frontend
cd C:\Users\Shivam\cbt-exam && npm run dev

# Test parser
node scripts/epub-parser.js "path/to/book.epub"

# Run automation manually
node scripts/automation-runner.js

# Check logs
type logs\automation-*.log

# Check database
mongosh cbt-exam
> db.questions.countDocuments()
```

---

**Need help?** Check [TESTING_CHECKLIST.md](./TESTING_CHECKLIST.md) for detailed testing steps!
