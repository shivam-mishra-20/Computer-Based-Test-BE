import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { createAdapter } from '@socket.io/redis-adapter';
import { redisPublisher, redisSubscriber } from '../config/redis';

class SocketService {
  private static instance: SocketService;
  private io: Server | null = null;
  private connectionCount: number = 0;
  private readonly MAX_CONNECTIONS = 10000; // Per server instance
  private readonly MAX_ROOMS_PER_SOCKET = 50;

  private constructor() {}

  public static getInstance(): SocketService {
    if (!SocketService.instance) {
      SocketService.instance = new SocketService();
    }
    return SocketService.instance;
  }

  public init(httpServer: HttpServer): void {
    this.io = new Server(httpServer, {
      cors: {
        origin: process.env.CORS_ORIGIN || '*',
        methods: ['GET', 'POST'],
        credentials: true
      },
      // Performance & Security Optimizations
      pingTimeout: 60000,
      pingInterval: 25000,
      upgradeTimeout: 10000,
      maxHttpBufferSize: 1e6, // 1MB max message size
      transports: ['websocket', 'polling'],
      allowEIO3: false,
      perMessageDeflate: {
        threshold: 1024, // Compress messages > 1KB
      },
      httpCompression: {
        threshold: 1024,
      }
    });

    // Redis Adapter for Horizontal Scaling
    this.io.adapter(createAdapter(redisPublisher, redisSubscriber));
    console.log('✅ Socket.IO Redis adapter initialized');

    // Authentication Middleware
    this.io.use((socket: Socket, next) => {
      // Connection limit per server instance
      if (this.connectionCount >= this.MAX_CONNECTIONS) {
        return next(new Error('Server at capacity, please try again later'));
      }

      const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.split(' ')[1];
      if (!token) {
        return next(new Error('Authentication error: No token provided'));
      }

      jwt.verify(token, process.env.JWT_SECRET as string, (err: any, decoded: any) => {
        if (err) {
          return next(new Error('Authentication error: Invalid token'));
        }
        (socket as any).user = decoded;
        next();
      });
    });

    this.io.on('connection', (socket: Socket) => {
      this.connectionCount++;
      
      const userId = (socket as any).user?.id;
      const role = (socket as any).user?.role;
      let roomCount = 0;

      console.log(`[Socket] User connected: ${socket.id} | User: ${userId} | Total: ${this.connectionCount}`);

      // Join user-specific room
      if (userId) {
        socket.join(`user:${userId}`);
        roomCount++;
        
        // Role-specific room
        if (role === 'teacher') {
          socket.join(`teacher:${userId}`);
          roomCount++;
        }
      }

      // Rate limiter per socket (prevent spam)
      const messageTimestamps: number[] = [];
      const MAX_MESSAGES_PER_MINUTE = 30;

      const checkRateLimit = (): boolean => {
        const now = Date.now();
        const oneMinuteAgo = now - 60000;
        
        // Remove old timestamps
        while (messageTimestamps.length > 0 && messageTimestamps[0] < oneMinuteAgo) {
          messageTimestamps.shift();
        }
        
        if (messageTimestamps.length >= MAX_MESSAGES_PER_MINUTE) {
          return false; // Rate limit exceeded
        }
        
        messageTimestamps.push(now);
        return true;
      };

      // Join class room with validation
      socket.on('join_class', (classId: string) => {
        if (!classId || typeof classId !== 'string' || classId.length > 100) {
          return socket.emit('error', { message: 'Invalid class ID' });
        }
        
        if (roomCount >= this.MAX_ROOMS_PER_SOCKET) {
          return socket.emit('error', { message: 'Maximum rooms joined' });
        }
        
        socket.join(`class:${classId}`);
        roomCount++;
        console.log(`[Socket] ${socket.id} joined class:${classId}`);
      });
      
      socket.on('leave_class', (classId: string) => {
        if (classId && typeof classId === 'string') {
          socket.leave(`class:${classId}`);
          roomCount = Math.max(0, roomCount - 1);
        }
      });

      // Join doubt room with rate limiting
      socket.on('join_doubt', (doubtId: string) => {
        if (!doubtId || typeof doubtId !== 'string' || doubtId.length > 100) {
          return socket.emit('error', { message: 'Invalid doubt ID' });
        }
        
        if (roomCount >= this.MAX_ROOMS_PER_SOCKET) {
          return socket.emit('error', { message: 'Maximum rooms joined' });
        }

        if (!checkRateLimit()) {
          return socket.emit('error', { message: 'Rate limit exceeded' });
        }
        
        socket.join(`doubt_${doubtId}`);
        roomCount++;
        console.log(`[Socket] ${socket.id} joined doubt_${doubtId}`);
      });
      
      socket.on('leave_doubt', (doubtId: string) => {
        if (doubtId && typeof doubtId === 'string') {
          socket.leave(`doubt_${doubtId}`);
          roomCount = Math.max(0, roomCount - 1);
        }
      });

      // Typing indicator (with rate limiting)
      socket.on('typing', (data: { doubtId: string; isTyping: boolean }) => {
        if (!checkRateLimit()) return;
        
        if (data?.doubtId && typeof data.isTyping === 'boolean') {
          socket.to(`doubt_${data.doubtId}`).emit('user_typing', {
            userId,
            isTyping: data.isTyping
          });
        }
      });

      socket.on('disconnect', () => {
        this.connectionCount = Math.max(0, this.connectionCount - 1);
        console.log(`[Socket] User disconnected: ${socket.id} | Total: ${this.connectionCount}`);
      });

      socket.on('error', (error) => {
        console.error(`[Socket] Error on ${socket.id}:`, error);
      });
    });

    console.log('Socket.IO initialized');
  }

  public getIO(): Server {
    if (!this.io) {
      throw new Error('Socket.IO not initialized!');
    }
    return this.io;
  }

  public emitToUser(userId: string, event: string, data: any): void {
    if (!this.io) return;
    this.io.to(`user:${userId}`).emit(event, data);
  }

  public emitToClass(classId: string, event: string, data: any): void {
    if (!this.io) return;
    this.io.to(`class:${classId}`).emit(event, data);
  }

  /**
   * Emit a message to the doubt room AND to both participant user rooms.
   * This ensures users get updates whether they're in the chat or on the list screen.
   * Uses Redis adapter for cross-server communication in clustered setup.
   */
  public emitDoubtUpdate(doubtId: string, studentId: string, teacherId: string | null, event: string, data: any): void {
    if (!this.io) return;

    // Emit to doubt room with specific event
    this.io.to(`doubt_${doubtId}`).emit(event, data);
    
    // Emit to user rooms with generic update event
    const userRooms = [`user:${studentId}`];
    if (teacherId) {
      userRooms.push(`user:${teacherId}`);
    }
    this.io.to(userRooms).emit('doubt_updated', data);
  }

  /**
   * Get current connection count (for this server instance only)
   */
  public getConnectionCount(): number {
    return this.connectionCount;
  }

  /**
   * Broadcast to all connected sockets (expensive, use sparingly)
   */
  public broadcast(event: string, data: any): void {
    if (!this.io) return;
    this.io.emit(event, data);
  }
}

export default SocketService.getInstance();
