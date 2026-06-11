const express = require('express')
const http = require('http')
const { Server } = require('socket.io')
const cors = require('cors')

const app = express()
const server = http.createServer(app)

const io = new Server(server, {
  cors: {
    origin: ['https://www.cardgamers.io', 'https://cardgamers.io', 'https://cardgamers-io.vercel.app', 'http://localhost:3000'],
    methods: ['GET', 'POST'],
    credentials: true,
  }
})

app.use(cors())
app.use(express.json())

app.get('/health', (req, res) => res.json({ status: 'ok', rooms: Object.keys(rooms).length }))

// ─── Game state ───────────────────────────────────────────────────
const rooms = {}
const playerRooms = {}

// ─── Card utilities ───────────────────────────────────────────────
const SUITS = ['S', 'H', 'D', 'C']
const VALUES = ['2','3','4','5','6','7','8','9','10','J','Q','K','A']

function createDeck() {
  const deck = []
  for (const suit of SUITS)
    for (const value of VALUES)
      deck.push({ suit, value, id: `${value}${suit}` })
  return deck
}

function shuffle(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// ─── Rummy game logic ─────────────────────────────────────────────
function dealRummy(players) {
  const deck = shuffle(createDeck())
  const hands = {}
  const cardsEach = players.length === 2 ? 10 : 7
  players.forEach((pid, i) => {
    hands[pid] = deck.splice(0, cardsEach)
  })
  return {
    hands,
    drawPile: deck,
    discardPile: [deck.splice(0, 1)[0]],
    currentTurn: players[0],
    phase: 'draw', // draw or discard
    winner: null,
  }
}

function cardValue(val) {
  if (val === 'A') return 1
  if (['J','Q','K'].includes(val)) return 10
  return parseInt(val)
}

function handValue(hand) {
  return hand.reduce((sum, c) => sum + cardValue(c.value), 0)
}

// ─── Socket handlers ──────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`)

  // ── Lobby ──
  socket.on('get_rooms', ({ gameType }) => {
    const available = Object.values(rooms)
      .filter(r => r.gameType === gameType && r.status === 'waiting' && r.players.length < r.maxPlayers)
      .map(r => ({ id: r.id, name: r.name, players: r.players.length, maxPlayers: r.maxPlayers, host: r.hostName }))
    socket.emit('rooms_list', available)
  })

  socket.on('create_room', ({ gameType, roomName, username, maxPlayers }) => {
    const roomId = Math.random().toString(36).substr(2, 6).toUpperCase()
    rooms[roomId] = {
      id: roomId,
      name: roomName || `${username}'s Table`,
      gameType,
      maxPlayers: maxPlayers || (gameType === 'rummy' ? 2 : 4),
      players: [{ id: socket.id, username }],
      hostName: username,
      status: 'waiting',
      gameState: null,
      chat: [],
    }
    playerRooms[socket.id] = roomId
    socket.join(roomId)
    socket.emit('room_created', { roomId, room: sanitizeRoom(rooms[roomId], socket.id) })
    io.to(roomId).emit('room_updated', sanitizeRoom(rooms[roomId], socket.id))
  })

  socket.on('join_room', ({ roomId, username }) => {
    const room = rooms[roomId]
    if (!room) { socket.emit('error', { message: 'Room not found' }); return }
    if (room.players.length >= room.maxPlayers) { socket.emit('error', { message: 'Room is full' }); return }
    if (room.status !== 'waiting') { socket.emit('error', { message: 'Game already started' }); return }

    room.players.push({ id: socket.id, username })
    playerRooms[socket.id] = roomId
    socket.join(roomId)
    io.to(roomId).emit('room_updated', sanitizeRoom(room, socket.id))

    // Auto-start when full
    if (room.players.length === room.maxPlayers) {
      startGame(roomId)
    }
  })

  socket.on('send_chat', ({ roomId, message, username }) => {
    const room = rooms[roomId]
    if (!room) return
    const msg = { username, message, time: Date.now() }
    room.chat.push(msg)
    if (room.chat.length > 50) room.chat.shift()
    io.to(roomId).emit('chat_message', msg)
  })

  // ── Rummy actions ──
  socket.on('rummy_draw', ({ roomId, from }) => {
    const room = rooms[roomId]
    if (!room?.gameState) return
    const gs = room.gameState
    if (gs.currentTurn !== socket.id || gs.phase !== 'draw') return

    let card
    if (from === 'discard' && gs.discardPile.length > 0) {
      card = gs.discardPile.pop()
    } else if (gs.drawPile.length > 0) {
      card = gs.drawPile.pop()
      if (gs.drawPile.length === 0) {
        gs.drawPile = gs.discardPile.reverse()
        gs.discardPile = [gs.drawPile.pop()]
      }
    } else return

    gs.hands[socket.id].push(card)
    gs.phase = 'discard'
    broadcastGameState(roomId)
  })

  socket.on('rummy_discard', ({ roomId, cardId }) => {
    const room = rooms[roomId]
    if (!room?.gameState) return
    const gs = room.gameState
    if (gs.currentTurn !== socket.id || gs.phase !== 'discard') return

    const hand = gs.hands[socket.id]
    const cardIdx = hand.findIndex(c => c.id === cardId)
    if (cardIdx === -1) return

    const [card] = hand.splice(cardIdx, 1)
    gs.discardPile.push(card)

    // Check for win (gin - empty hand)
    if (hand.length === 0) {
      gs.winner = socket.id
      const winnerName = room.players.find(p => p.id === socket.id)?.username
      io.to(roomId).emit('game_over', { winner: socket.id, winnerName, reason: 'gin' })
      room.status = 'finished'
      return
    }

    // Next turn
    const playerIds = room.players.map(p => p.id)
    const currentIdx = playerIds.indexOf(socket.id)
    gs.currentTurn = playerIds[(currentIdx + 1) % playerIds.length]
    gs.phase = 'draw'
    broadcastGameState(roomId)
  })

  socket.on('rummy_knock', ({ roomId }) => {
    const room = rooms[roomId]
    if (!room?.gameState) return
    const gs = room.gameState
    if (gs.currentTurn !== socket.id) return

    const myValue = handValue(gs.hands[socket.id])
    if (myValue > 10) { socket.emit('error', { message: 'Hand value too high to knock (max 10)' }); return }

    // Find opponent with highest hand value
    let winner = socket.id
    let lowestVal = myValue
    room.players.forEach(p => {
      if (p.id !== socket.id) {
        const val = handValue(gs.hands[p.id])
        if (val < lowestVal) { winner = p.id; lowestVal = val }
      }
    })

    const winnerName = room.players.find(p => p.id === winner)?.username
    gs.winner = winner
    io.to(roomId).emit('game_over', { winner, winnerName, reason: 'knock', scores: Object.fromEntries(room.players.map(p => [p.id, handValue(gs.hands[p.id])])) })
    room.status = 'finished'
  })

  // ── Disconnect ──
  socket.on('disconnect', () => {
    const roomId = playerRooms[socket.id]
    if (roomId && rooms[roomId]) {
      const room = rooms[roomId]
      room.players = room.players.filter(p => p.id !== socket.id)
      if (room.players.length === 0) {
        delete rooms[roomId]
      } else {
        if (room.status === 'playing') {
          io.to(roomId).emit('player_left', { message: 'A player disconnected. Game ended.' })
          room.status = 'finished'
        } else {
          io.to(roomId).emit('room_updated', sanitizeRoom(room, null))
        }
      }
    }
    delete playerRooms[socket.id]
    console.log(`Player disconnected: ${socket.id}`)
  })
})

function startGame(roomId) {
  const room = rooms[roomId]
  if (!room) return
  room.status = 'playing'

  if (room.gameType === 'rummy') {
    const playerIds = room.players.map(p => p.id)
    room.gameState = dealRummy(playerIds)
  }

  broadcastGameState(roomId)
  io.to(roomId).emit('game_started', { gameType: room.gameType })
}

function sanitizeRoom(room, socketId) {
  return {
    id: room.id,
    name: room.name,
    gameType: room.gameType,
    maxPlayers: room.maxPlayers,
    status: room.status,
    hostName: room.hostName,
    players: room.players.map(p => ({ id: p.id, username: p.username })),
    chat: room.chat.slice(-20),
  }
}

function broadcastGameState(roomId) {
  const room = rooms[roomId]
  if (!room?.gameState) return
  const gs = room.gameState

  // Send each player their own hand, hide others
  room.players.forEach(player => {
    const personalState = {
      myHand: gs.hands[player.id] || [],
      myTurn: gs.currentTurn === player.id,
      phase: gs.phase,
      discardTop: gs.discardPile[gs.discardPile.length - 1] || null,
      drawPileCount: gs.drawPile.length,
      currentTurnId: gs.currentTurn,
      currentTurnName: room.players.find(p => p.id === gs.currentTurn)?.username,
      opponentCardCounts: Object.fromEntries(
        room.players.filter(p => p.id !== player.id).map(p => [p.id, gs.hands[p.id]?.length || 0])
      ),
      players: room.players,
    }
    io.to(player.id).emit('game_state', personalState)
  })
}

const server.listen(PORT, '0.0.0.0', () => console.log(`CardGamers game server running on port ${PORT}`))PORT = process.env.PORT || 8080
server.listen(PORT, () => console.log(`CardGamers game server running on port ${PORT}`))
