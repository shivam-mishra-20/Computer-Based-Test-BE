import app from './app';
import { connectDB } from './config/db';

const PORT = process.env.PORT || 5000;

// Start the HTTP server immediately
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Connect to the database asynchronously (do not block server startup)
connectDB().catch((err) => {
  console.error('Database connection failed at startup:', err);
});

// Optional: handle graceful shutdown
process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
