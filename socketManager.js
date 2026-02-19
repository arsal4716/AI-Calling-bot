const { Server } = require('socket.io');

let io;

module.exports = {
  init: (httpServer) => {
    io = new Server(httpServer, {
      cors: {
        origin: process.env.FRONTEND_URL || '*', 
        methods: ['GET', 'POST'],
        credentials: true
      },
      path: '/socket.io' 
    });

    io.on('connection', (socket) => {
      console.log('Socket connected:', socket.id);

      socket.on('join-job', (jobId) => {
        socket.join(`job:${jobId}`);
        console.log(`Socket ${socket.id} joined room job:${jobId}`);
      });

      socket.on('leave-job', (jobId) => {
        socket.leave(`job:${jobId}`);
        console.log(`Socket ${socket.id} left room job:${jobId}`);
      });

      socket.on('disconnect', () => {
        console.log('Socket disconnected:', socket.id);
      });
    });

    return io;
  },
  getIo: () => {
    if (!io) {
      throw new Error('Socket.io not initialized. Call init first.');
    }
    return io;
  }
};