import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';

class SocketService {
  private static instance: SocketService;
  private io: Server | null = null;

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
        origin: '*', // Adjust for production
        methods: ['GET', 'POST']
      }
    });

    this.io.use((socket: Socket, next) => {
      const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.split(' ')[1];
      if (!token) {
        return next(new Error('Authentication error: No token provided'));
      }

      jwt.verify(token, process.env.JWT_SECRET as string, (err: any, decoded: any) => {
        if (err) {
          return next(new Error('Authentication error: Invalid token'));
        }
        (socket as any).user = decoded; // Attach user to socket
        next();
      });
    });

    this.io.on('connection', (socket: Socket) => {
      console.log('User connected:', socket.id, (socket as any).user?.id);
      const userId = (socket as any).user?.id;
      const role = (socket as any).user?.role;

      if (userId) {
        socket.join(`user:${userId}`);
        console.log(`Socket ${socket.id} joined user:${userId}`);
      }

      // Add specific logic for teacher/student rooms if needed
      if (role === 'teacher') {
         socket.join(`teacher:${userId}`);
      }

      socket.on('join_class', (classId: string) => {
        socket.join(`class:${classId}`);
        console.log(`Socket ${socket.id} joined class:${classId}`);
      });
      
      socket.on('leave_class', (classId: string) => {
        socket.leave(`class:${classId}`);
      });

      socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
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
    this.io?.to(`user:${userId}`).emit(event, data);
  }

  public emitToClass(classId: string, event: string, data: any): void {
    this.io?.to(`class:${classId}`).emit(event, data);
  }
}

export default SocketService.getInstance();
