import { Server as HttpServer } from 'http';
import mongoose from 'mongoose';
import { currentOrgId, runWithTenant, withoutTenantScope } from '../core/tenancy';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { credentialRefusal, effectiveLegacyRole, principalOf } from '../middlewares/authMiddleware';
import { resolveUserPermissions } from '../core/rbac/resolve';
import { canAccessDoubt, type DoubtViewerRole } from './doubtService';
import User from '../models/User';
import Doubt from '../models/Doubt';
import { createAdapter } from '@socket.io/redis-adapter';
import { isRedisEnabled, redisPublisher, redisSubscriber } from '../config/redis';

/**
 * The room name for a class, namespaced by organization.
 *
 * ── Why this cannot be `class:${classId}` ───────────────────────────────────
 * A class LEVEL is not globally unique. Every institute on the platform has an
 * "11", so `class:11` was one broadcast channel shared by all of them: an
 * attendance update for one organization's class 11 would reach every other
 * organization's class 11 as well.
 *
 * No shipped client ever called `join_class`, which made this latent rather
 * than an active leak — but the first client to use it would have inherited a
 * cross-tenant channel, and nothing in the code would have said so.
 *
 * Rooms keyed on a genuinely unique id — `user:<ObjectId>`, `doubt_<ObjectId>`
 * — need no namespace and do not have one.
 */
export function classRoom(orgId: string | null | undefined, classId: string): string {
  return orgId ? `class:${orgId}:${classId}` : `class:${classId}`;
}

/** Who a socket is, established once at the handshake. */
interface SocketPrincipal {
  id: string;
  role: string;
  /** Null only on a pre-tenancy (single-institute) deployment, or for a learner. */
  orgId: string | null;
}

/**
 * The same rules as authMiddleware, for a socket: a session credential (not a
 * platform or refresh token), not revoked, for an account whose organization
 * is the one the socket is then confined to.
 *
 * The handshake used to accept ANY token signed with the secret — a platform
 * staff token, a refresh token, a token revoked by "sign out everywhere" — and
 * the room names below were built from `currentOrgId()`, which is always null
 * inside a socket event, so class rooms were not per-organization at all.
 */
export async function socketPrincipal(token: string): Promise<SocketPrincipal | null> {
  let decoded: { id?: string; aud?: string; tv?: unknown };
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET as string) as typeof decoded;
  } catch {
    return null;
  }
  if (!decoded.id || (decoded.aud && decoded.aud !== 'tenant' && decoded.aud !== 'legacy')) return null;
  const user = (await withoutTenantScope('socket:principal', async () =>
    User.findById(decoded.id).select('role status orgId accountType tokenVersion roleIds').lean(),
  )) as Record<string, unknown> | null;
  if (!user || credentialRefusal(decoded, user)) return null;
  const principal = principalOf(user as never);
  if (principal.kind === 'foreign' || principal.kind === 'unattached') return null;
  const orgId = principal.kind === 'tenant' ? principal.orgId : null;
  // The role a narrowed custom role actually grants, as on every HTTP route.
  const access = await withoutTenantScope('socket:access', async () =>
    resolveUserPermissions({ ...(user as object), orgId } as never),
  );
  const role = effectiveLegacyRole(user.role as string | undefined, access) ?? 'student';
  return { id: String(decoded.id), role, orgId };
}

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
    // CORS_ORIGIN is a COMMA-SEPARATED list. Passing the raw string to socket.io
    // makes it a single (unmatchable) origin, so browsers get CORS-blocked on the
    // websocket handshake — breaking real-time on WEB while native apps (no Origin
    // header) still work. Split it into an array so each origin is matched.
    const socketOrigins = process.env.CORS_ORIGIN
      ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean)
      : true; // reflect any origin when unset (dev)

    this.io = new Server(httpServer, {
      cors: {
        origin: socketOrigins,
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

    /**
     * Redis adapter for horizontal scaling.
     *
     * Skipped when Redis is disabled. Without it, sockets still work — events
     * simply do not cross worker processes, which is correct for a single
     * worker and is a far better outcome than refusing to start.
     */
    if (isRedisEnabled) {
      // The platform runtime shares Redis with the existing system; its own
      // key keeps a room name such as `class:11` from carrying one system's
      // events to the other's sockets. The existing system keeps the default.
      this.io.adapter(
        createAdapter(redisPublisher, redisSubscriber, { key: process.env.SOCKET_ADAPTER_KEY || 'socket.io' }),
      );
      console.log('✅ Socket.IO Redis adapter initialized');
    } else {
      console.warn(
        'ℹ️ Socket.IO running WITHOUT the Redis adapter — events do not cross worker processes.',
      );
    }

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

      socketPrincipal(String(token))
        .then((principal) => {
          if (!principal) return next(new Error('Authentication error: Invalid token'));
          (socket as any).user = { id: principal.id, role: principal.role, orgId: principal.orgId };
          next();
        })
        .catch(() => next(new Error('Authentication error: Invalid token')));
    });

    this.io.on('connection', (socket: Socket) => {
      this.connectionCount++;
      
      const userId = (socket as any).user?.id;
      const role = (socket as any).user?.role;
      // The socket's organization, fixed at the handshake. Never the event's.
      const orgId: string | null = (socket as any).user?.orgId ?? null;
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
        
        socket.join(classRoom(orgId, classId));
        roomCount++;
        console.log(`[Socket] ${socket.id} joined class:${classId}`);
      });
      
      socket.on('leave_class', (classId: string) => {
        if (classId && typeof classId === 'string') {
          socket.leave(classRoom(orgId, classId));
          roomCount = Math.max(0, roomCount - 1);
        }
      });

      // Join doubt room with rate limiting. Only a participant may listen: the
      // room carries every message of the conversation, and it used to admit
      // any signed-in socket that named the id — another student, or another
      // organization's.
      socket.on('join_doubt', async (doubtId: string) => {
        if (!doubtId || typeof doubtId !== 'string' || doubtId.length > 100) {
          return socket.emit('error', { message: 'Invalid doubt ID' });
        }

        if (roomCount >= this.MAX_ROOMS_PER_SOCKET) {
          return socket.emit('error', { message: 'Maximum rooms joined' });
        }

        if (!checkRateLimit()) {
          return socket.emit('error', { message: 'Rate limit exceeded' });
        }

        try {
          if (!(await this.mayJoinDoubt(doubtId, userId, role, orgId))) {
            return socket.emit('error', { message: 'Doubt not found' });
          }
        } catch {
          return socket.emit('error', { message: 'Doubt not found' });
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
        
        // Only into a room this socket was admitted to.
        if (data?.doubtId && typeof data.isTyping === 'boolean' && socket.rooms.has(`doubt_${data.doubtId}`)) {
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

  /** A participant of this conversation, in the socket's own organization. */
  public async mayJoinDoubt(doubtId: string, userId: string, role: string, orgId: string | null): Promise<boolean> {
    if (!mongoose.Types.ObjectId.isValid(doubtId)) return false;
    if (role !== 'student' && role !== 'teacher' && role !== 'admin') return false;
    const find = () => Doubt.findById(doubtId).select('student teacher messages.sender').lean();
    // Looked up in the socket's organization, so the tenancy plugin applies
    // exactly the scope an HTTP request from this account would get.
    const doubt = orgId ? await runWithTenant({ orgId, userId, source: 'session' }, find) : await find();
    return Boolean(doubt) && canAccessDoubt(doubt, { id: userId, role: role as DoubtViewerRole });
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

  /**
   * `orgId` is explicit because the usual caller is a background worker, which
   * has no ambient request context to fall back on.
   */
  public emitToClass(classId: string, event: string, data: any, orgId?: string | null): void {
    if (!this.io) return;
    this.io.to(classRoom(orgId ?? currentOrgId(), classId)).emit(event, data);
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
   * Emit permanent doubt deletion to all relevant listeners.
   */
  public emitDoubtDeleted(doubtId: string, studentId: string, teacherId: string | null): void {
    if (!this.io) return;

    const payload = { doubtId };
    this.io.to(`doubt_${doubtId}`).emit('doubt_deleted', payload);

    const userRooms = [`user:${studentId}`];
    if (teacherId) {
      userRooms.push(`user:${teacherId}`);
    }

    this.io.to(userRooms).emit('doubt_deleted', payload);
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
