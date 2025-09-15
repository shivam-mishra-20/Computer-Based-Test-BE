# ----------------------------
# INIT & DEPENDENCIES
# ----------------------------
npm init -y

# Install core dependencies
npm install express mongoose jsonwebtoken bcrypt dotenv cors helmet morgan

# Install dev dependencies
npm install -D typescript ts-node-dev @types/express @types/node @types/jsonwebtoken @types/bcrypt @types/cors @types/morgan @types/helmet eslint prettier eslint-config-prettier eslint-plugin-prettier

# Initialize TypeScript config
npx tsc --init --rootDir src --outDir dist --esModuleInterop --resolveJsonModule --module commonjs --target es2020

# ----------------------------
# PROJECT STRUCTURE
# ----------------------------
mkdir -p src/{config,controllers,middlewares,models,routes,services,utils}
mkdir -p src/routes/api
touch src/server.ts
touch src/app.ts
touch src/config/{db.ts,env.ts}
touch src/middlewares/{authMiddleware.ts,errorHandler.ts}
touch src/utils/{logger.ts,response.ts}
touch src/services/{authService.ts,userService.ts}
touch src/controllers/{authController.ts,userController.ts}
touch src/models/{User.ts,Test.ts}
touch src/routes/api/{authRoutes.ts,userRoutes.ts,testRoutes.ts}
touch .env .eslintrc.js .prettierrc

# ----------------------------
# SAMPLE CODE
# ----------------------------

cat > src/server.ts << 'EOF'
import app from './app';
import { connectDB } from './config/db';

const PORT = process.env.PORT || 5000;

connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(\`🚀 Server running on port \${PORT}\`);
  });
});
EOF

cat > src/app.ts << 'EOF'
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import authRoutes from './routes/api/authRoutes';
import userRoutes from './routes/api/userRoutes';
import testRoutes from './routes/api/testRoutes';
import { errorHandler } from './middlewares/errorHandler';

dotenv.config();

const app = express();

app.use(express.json());
app.use(cors());
app.use(helmet());
app.use(morgan('dev'));

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/tests', testRoutes);

// Error handler
app.use(errorHandler);

export default app;
EOF

cat > src/config/db.ts << 'EOF'
import mongoose from 'mongoose';

export const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI as string);
    console.log('✅ MongoDB Connected');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};
EOF

cat > src/middlewares/authMiddleware.ts << 'EOF'
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ message: 'No token, authorization denied' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as { id: string };
    (req as any).user = decoded.id;
    next();
  } catch (err) {
    res.status(401).json({ message: 'Invalid token' });
  }
};
EOF

cat > src/middlewares/errorHandler.ts << 'EOF'
import { Request, Response, NextFunction } from 'express';

export const errorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ message: err.message || 'Server Error' });
};
EOF

cat > src/models/User.ts << 'EOF'
import mongoose, { Document, Schema } from 'mongoose';
import bcrypt from 'bcrypt';

export interface IUser extends Document {
  name: string;
  email: string;
  password: string;
  comparePassword(password: string): Promise<boolean>;
}

const userSchema = new Schema<IUser>({
  name: { type: String, required: true },
  email: { type: String, unique: true, required: true },
  password: { type: String, required: true },
}, { timestamps: true });

userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

userSchema.methods.comparePassword = function(password: string) {
  return bcrypt.compare(password, this.password);
};

export default mongoose.model<IUser>('User', userSchema);
EOF

cat > src/controllers/authController.ts << 'EOF'
import { Request, Response } from 'express';
import User from '../models/User';
import jwt from 'jsonwebtoken';

export const register = async (req: Request, res: Response) => {
  const { name, email, password } = req.body;
  try {
    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ message: 'User already exists' });

    const user = new User({ name, email, password });
    await user.save();

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET as string, { expiresIn: '1d' });
    res.status(201).json({ token });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
};

export const login = async (req: Request, res: Response) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user || !(await user.comparePassword(password))) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET as string, { expiresIn: '1d' });
    res.json({ token });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
};
EOF

cat > src/routes/api/authRoutes.ts << 'EOF'
import { Router } from 'express';
import { register, login } from '../../controllers/authController';

const router = Router();

router.post('/register', register);
router.post('/login', login);

export default router;
EOF

cat > .env << 'EOF'
PORT=5000
MONGO_URI=mongodb://localhost:27017/cbt-system
JWT_SECRET=supersecretjwtkey
EOF

cat > .eslintrc.js << 'EOF'
module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2020, sourceType: 'module' },
  plugins: ['@typescript-eslint', 'prettier'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'plugin:prettier/recommended'],
  rules: { 'prettier/prettier': 'error' },
};
EOF

cat > .prettierrc << 'EOF'
{
  "singleQuote": true,
  "semi": true,
  "tabWidth": 2,
  "trailingComma": "all"
}
EOF

echo "✅ Backend scaffold complete! Run with: npx ts-node-dev src/server.ts"
