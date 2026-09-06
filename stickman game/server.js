import express from 'express';
import http from 'http';
import { Server } from 'socket.io';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public')); // serve index.html from /public

const queue = [];        // players waiting for a match
const rooms = new Map(); // roomId -> { players: [...], state: {...} }

function createRoomId() {
  return 'room-' + Math.random().toString(36).slice(2, 8);
}

// Push a state change to everyone in a room
function broadcast(roomId, event, payload) {
  const room = rooms.get(roomId);
  if (!room) return;
  io.to(roomId).emit(event, { roomId, payload });
}

// --- Matchmaking: pair 2 queued players ---
function tryMatch() {
  if (queue.length < 2) return;
  const a = queue.shift();
  const b = queue.shift();
  const roomId = createRoomId();

  rooms.set(roomId, {
    players: [a, b],
    state: { layout: null, lives: { [a]: 10, [b]: 10 }, over: false }
  });

  [a, b].forEach(p => p.join(roomId));
  io.to(roomId).emit('match', {
    roomId,
    youArePlayer: 'P1',
    opponent: 'P2',
    // both sides use mirrored field orientation
  });
}

io.on('connection', (socket) => {
  console.log('connected', socket.id);

  socket.on('findMatch', () => {
    queue.push(socket);
    socket.emit('queued');
    tryMatch();
  });

  // Player finished building their defense layout -> send to opponent
  socket.on('submitLayout', ({ layout }) => {
    const room = getRoom(socket);
    if (!room) return;
    // Tower defense PVP: you defend your field against the opponent's
    // waves. So opponent attacks YOUR layout in their own simulation,
    // and vice versa. Exchange layouts:
    const opp = room.players.find(p => p !== socket);
    io.to(opp.id).emit('enemyLayout', { layout });
  });

  socket.on('attackResult', ({ roomId, wavesSurvived }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    // You defended wavesSurvived waves against opponent's layout.
    // Record it, decide winner, send to all.
    const me = room.players.indexOf(socket);
    room.state.survived = room.state.survived || [];
    room.state.survived[me] = wavesSurvived;
    if (room.state.survived.filter(x => x !== undefined).length === 2) {
      const [sA, sB] = room.state.survived;
      const winner = sA === sB ? 'DRAW' : (sA > sB ? room.players[0].id : room.players[1].id);
      io.to(roomId).emit('gameOver', { winner, scores: { sA, sB } });
    }
  });

  socket.on('leave', () => leaveRoom(socket));
  socket.on('disconnect', () => {
    // remove from queue
    const qi = queue.indexOf(socket);
    if (qi !== -1) queue.splice(qi, 1);
    leaveRoom(socket);
  });
});

function getRoom(socket) {
  for (const [roomId, room] of rooms) {
    if (room.players.includes(socket)) return { roomId, room };
  }
  return null;
}
function leaveRoom(socket) {
  const found = getRoom(socket);
  if (!found) return;
  const { roomId, room } = found;
  room.players.forEach(p => p.emit('opponentLeft'));
  rooms.delete(roomId);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('PVP server on http://localhost:' + PORT));
