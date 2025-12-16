const express = require('express');
const app = express();
const server = require('http').createServer(app);
const io = require('socket.io')(server, {
    cors: { origin: "*" },
    transports: ['polling', 'websocket']
});

const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

let gameRoom = {
    players: {},
    pipes: [],
    gameStarted: false
};

io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);
    
    // Check if room is full
    const playerCount = Object.keys(gameRoom.players).length;
    
    if (playerCount >= 2) {
        socket.emit('roomFull');
        socket.disconnect();
        return;
    }
    
    // Add player to room
    const playerNumber = playerCount + 1;
    gameRoom.players[socket.id] = {
        id: socket.id,
        number: playerNumber,
        alive: true,
        score: 0
    };
    
    console.log(`Player ${playerNumber} joined. Total players: ${Object.keys(gameRoom.players).length}`);
    
    socket.emit('playerJoined', { 
        playerId: socket.id,
        playerNumber: playerNumber,
        otherPlayers: Object.keys(gameRoom.players).filter(id => id !== socket.id)
    });
    
    // Notify other players
    socket.broadcast.emit('newPlayer', {
        playerId: socket.id,
        playerNumber: playerNumber
    });
    
    // Start game when 2 players
    const currentPlayers = Object.keys(gameRoom.players).length;
    console.log(`Checking player count: ${currentPlayers}`);
    
    if (currentPlayers === 2) {
        console.log('Starting game with 2 players!');
        setTimeout(() => {
            gameRoom.gameStarted = true;
            io.emit('startGame');
            console.log('Game start signal sent to all players');
        }, 1500);
    }
    
    // Bird position update
    socket.on('birdUpdate', (data) => {
        socket.broadcast.emit('opponentBird', {
            playerId: socket.id,
            ...data
        });
    });
    
    // Pipe sync (player 1 is host)
    socket.on('pipeSync', (pipes) => {
        if (gameRoom.players[socket.id]?.number === 1) {
            gameRoom.pipes = pipes;
            socket.broadcast.emit('pipesUpdate', pipes);
        }
    });
    
    // Score update
    socket.on('scoreUpdate', (score) => {
        if (gameRoom.players[socket.id]) {
            gameRoom.players[socket.id].score = score;
            io.emit('scoresUpdate', {
                playerId: socket.id,
                score: score
            });
        }
    });
    
    // Player died
    socket.on('playerDied', () => {
        if (gameRoom.players[socket.id]) {
            gameRoom.players[socket.id].alive = false;
            
            const alivePlayers = Object.values(gameRoom.players).filter(p => p.alive);
            
            if (alivePlayers.length === 0) {
                // Both dead, highest score wins
                const players = Object.values(gameRoom.players);
                const winner = players[0].score > players[1].score ? players[0] : players[1];
                io.emit('gameOver', { winnerId: winner.id, scores: gameRoom.players });
            } else if (alivePlayers.length === 1) {
                // One still alive
                io.emit('gameOver', { winnerId: alivePlayers[0].id, scores: gameRoom.players });
            }
        }
    });
    
    // Disconnect
    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
        delete gameRoom.players[socket.id];
        socket.broadcast.emit('playerLeft', socket.id);
        
        // Reset game if needed
        if (Object.keys(gameRoom.players).length < 2) {
            gameRoom.gameStarted = false;
            gameRoom.pipes = [];
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
