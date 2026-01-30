# Frontend Integration Guide

## 📊 AutomationDashboard Component

The AutomationDashboard component has been created in your **cbt-exam** frontend project at:
```
src/components/admin/AutomationDashboard.tsx
```

## 🎯 Features

### 1. Real-Time Monitoring
- **Auto-refresh every 10 seconds** to show latest status
- Manual refresh button for instant updates
- Live status indicators (ENABLED/DISABLED, RUNNING/IDLE)

### 2. Control Panel
- **Enable/Disable** automation with one click
- **Run Now** button to trigger immediate processing
- Safety locks (can't disable while running, can't run if disabled)

### 3. Statistics Dashboard
Shows comprehensive metrics:
- **Total Books Processed**
- **Questions Extracted** (total count)
- **Successfully Imported** (with success rate %)
- **With Diagrams** (count and percentage)

### 4. Quality Metrics
Visual progress bars showing:
- **Correct Answers Coverage** (%)
- **MCQ Options Coverage** (%)
- **Diagram Coverage** (%)

### 5. Processing History
Table view with:
- Book name and metadata (subject, class, board)
- Status badges (completed, processing, failed, pending)
- Question counts (total, imported, diagrams, answers)
- Timestamps

## 🚀 Integration Steps

### Step 1: Add to Admin Routes

Create/update `src/app/dashboard/automation/page.tsx`:

```tsx
import AutomationDashboard from '@/components/admin/AutomationDashboard';

export default function AutomationPage() {
  return <AutomationDashboard />;
}
```

### Step 2: Add to Admin Navigation

Update your admin sidebar/navigation:

```tsx
// In your navigation component
<Link href="/dashboard/automation">
  <span>📚 EPUB Automation</span>
</Link>
```

### Step 3: Protect the Route

Ensure only admins can access:

```tsx
// In your layout.tsx or middleware
if (user.role !== 'admin') {
  redirect('/dashboard');
}
```

### Step 4: Verify API Endpoints

Make sure these endpoints are working:
- `GET /api/automation/status` - Fetch current status
- `POST /api/automation/toggle` - Enable/disable
- `POST /api/automation/trigger` - Manual trigger
- `GET /api/automation/stats` - Get processing history

## 🎨 UI Dependencies

The component uses shadcn/ui components. Install if missing:

```bash
# If you haven't set up shadcn/ui yet
npx shadcn-ui@latest init

# Add required components
npx shadcn-ui@latest add card
npx shadcn-ui@latest add button
npx shadcn-ui@latest add badge
```

## 📱 Mobile Responsive

The dashboard is fully responsive:
- Desktop: 4-column grid for stats
- Tablet: 2-column grid
- Mobile: Single column stack

Update CSS if needed in `globals.css`:

```css
@media (max-width: 768px) {
  .grid-cols-4 {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 480px) {
  .grid-cols-4 {
    grid-template-columns: 1fr;
  }
}
```

## 🔐 Authentication

The component expects JWT token in localStorage:

```typescript
localStorage.getItem('token')
```

Make sure your login flow sets this:

```typescript
// After successful login
localStorage.setItem('token', response.data.token);
```

## 📊 Real-World Usage Example

```typescript
// Example: Monitoring while automation runs
1. Enable automation: Click "▶️ Enable"
2. Trigger run: Click "▶️ Run Now"
3. Watch real-time updates:
   - Status changes to "🔄 YES" (Running)
   - Progress updates every 10 seconds
   - New rows appear in Processing History table
4. After completion:
   - Status returns to "✓ NO" (Idle)
   - Summary stats update with new totals
   - Table shows "completed" badge

// Example: Quality Review
1. Check "Quality Metrics" section
2. Review percentages:
   - If "With Correct Answers" < 80%, review parser logic
   - If "With Diagrams" = 0%, check image extraction
   - If "With Options" low for MCQ books, verify option detection
```

## 🐛 Troubleshooting

### Issue: "Failed to fetch automation data"
**Solution**: 
- Check backend is running on correct port
- Verify CORS is configured for frontend domain
- Check token is valid (not expired)

### Issue: Stats not updating
**Solution**:
- Check 10-second auto-refresh is working
- Click manual refresh button
- Open browser DevTools Network tab to see API calls
- Verify `/api/automation/stats` returns 200 status

### Issue: Can't toggle automation
**Solution**:
- Ensure user is admin (check token payload)
- Check automation is not currently running
- Verify `/api/automation/toggle` endpoint is accessible

### Issue: "Run Now" button disabled
**Solution**:
- Make sure automation is enabled first
- Wait if currently running (check status)
- Verify class_12 folder has EPUB files

## 🎯 Next Steps

1. **Add to your admin dashboard**: Link from main admin page
2. **Test with sample run**: Click "Run Now" and watch progress
3. **Schedule 2 PM runs**: Use Task Scheduler (see START_HERE.md)
4. **Monitor quality**: Review metrics after each run
5. **Customize styling**: Adjust colors/layout to match your theme

## 📈 Advanced Features (Optional)

### Add Email Notifications
```typescript
// In automation-runner.js
import nodemailer from 'nodemailer';

async function sendCompletionEmail(stats) {
  // Send email with summary
}
```

### Add Charts
```bash
npm install recharts
```

```tsx
import { LineChart, Line, XAxis, YAxis } from 'recharts';

// Show extraction trends over time
<LineChart data={historicalStats}>
  <Line type="monotone" dataKey="imported" stroke="#8884d8" />
</LineChart>
```

### Add Filters
```tsx
// Filter by status, date range, book
<Select onValueChange={handleFilter}>
  <option value="all">All Status</option>
  <option value="completed">Completed</option>
  <option value="failed">Failed</option>
</Select>
```

---

**🎉 Dashboard is ready to use! Open `/dashboard/automation` in your admin panel.**
