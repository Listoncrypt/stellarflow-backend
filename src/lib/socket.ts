import { Server } from "socket.io";

let io: Server | null = null;

export function initSocket(server: import("http").Server): Server {
  io = new Server(server, {
    cors: { origin: "*" },
  });

  io.on("connection", (socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);
    socket.on("disconnect", () =>
      console.log(`🔌 Client disconnected: ${socket.id}`),
    );
  });

  return io;
}

export function getIO(): Server {
  if (!io) throw new Error("Socket.io not initialized");
  return io;
}
