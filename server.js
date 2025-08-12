// server.js
const WebSocket = require('ws');

const PORT = 8080;
const wss = new WebSocket.Server({ port: PORT });
console.log(`Server running on ws://localhost:${PORT}`);

/* === Game settings === */
const TICK_MS = 33; // ~30 updates/sec
const MAP_SIZE = 50;
const PLAYER_RADIUS = 1;
const BULLET_RADIUS = 0.2;
const PLAYER_MAX_HP = 100;
const DEFAULT_KILLS_TO_WIN = 20;
const RESPAWN_MS = 2000;
const PICKUP_SPAWN_INTERVAL = 5000; // ms
const PICKUP_MAX = 10;

/* === Weapons definitions === */
const WEAPONS = {
  pistol: { id:'pistol', name:'Pistol', cooldown:300, damage:12, bulletsPerShot:1, spread:0 },
  shotgun: { id:'shotgun', name:'Shotgun', cooldown:800, damage:6, bulletsPerShot:6, spread:0.5 },
  rifle: { id:'rifle', name:'Rifle', cooldown:150, damage:10, bulletsPerShot:1, spread:0 },
  smg:   { id:'smg',   name:'SMG',    cooldown:120, damage:8, bulletsPerShot:1, spread:0.05 },
};

/* === Obstacles (top-down rectangles x,y,w,h) === */
const obstacles = [
  {x:-20, y:-10, w:10, h:2},
  {x:10, y:10,   w:5,  h:5},
  {x:0,  y:0,    w:2,  h:15},
  {x:-8, y:18,   w:16, h:2},
  {x:22, y:-5,   w:2,  h:22},
];

/* === Utility helpers === */
function nextId(){ return Math.random().toString(36).slice(2,9); }
function randRange(min,max){ return Math.random()*(max-min)+min; }
function clamp(v,min,max){ return Math.max(min, Math.min(max, v)); }
function now(){ return Date.now(); }

/* circle-rect collision */
function circleRectColliding(cx, cy, cr, rx, ry, rw, rh){
  const closestX = Math.max(rx, Math.min(cx, rx + rw));
  const closestY = Math.max(ry, Math.min(cy, ry + rh));
  const dx = cx - closestX;
  const dy = cy - closestY;
  return (dx*dx + dy*dy) < cr*cr;
}
/* circle-circle */
function circleCircle(cx,cy,cr, x2,y2,r2){
  const dx = x2-cx, dy = y2-cy;
  const rs = (cr+r2)*(cr+r2);
  return dx*dx + dy*dy < rs;
}

/* === Lobby class === */
class Lobby {
  constructor(id, region='Custom', alwaysOpen=false){
    this.id = id;
    this.region = region;
    this.alwaysOpen = alwaysOpen;
    this.players = new Map(); // playerId -> player obj
    this.bullets = []; // {id,x,y,vx,vy,ownerId,damage}
    this.pickups = []; // {id,type,subType,x,y} type: 'gun'|'power'
    this.killsToWin = DEFAULT_KILLS_TO_WIN;
    this.gameStarted = alwaysOpen ? true : false;
    this.lastPickupSpawn = now();
    this.lastTick = now();
  }
  spawnPickupRandom(){
    if(this.pickups.length >= PICKUP_MAX) return;
    let tries=0;
    while(tries++ < 50){
      const px = randRange(-MAP_SIZE, MAP_SIZE);
      const py = randRange(-MAP_SIZE, MAP_SIZE);
      // avoid obstacles
      if(obstacles.some(o => circleRectColliding(px, py, 1.5, o.x, o.y, o.w, o.h))) continue;
      // avoid players
      if([...this.players.values()].some(p => circleCircle(px,py,1.5,p.x,p.y,PLAYER_RADIUS+0.5))) continue;
      // create pickup
      const isGun = Math.random() < 0.6; // more guns than powerups
      if(isGun){
        const gunKeys = Object.keys(WEAPONS);
        const gun = gunKeys[Math.floor(Math.random()*gunKeys.length)];
        this.pickups.push({id: nextId(), type:'gun', subType: gun, x:px, y:py});
      } else {
        const powerTypes = ['health','speed'];
        const pw = powerTypes[Math.floor(Math.random()*powerTypes.length)];
        this.pickups.push({id: nextId(), type:'power', subType: pw, x:px, y:py});
      }
      break;
    }
  }
  spawnInitialPickups(){
    for(let i=0;i<6;i++) this.spawnPickupRandom();
  }
}

/* === Lobbies map with default AUS & USA === */
const lobbies = new Map();
lobbies.set('aus', new Lobby('aus','Australia', true));
lobbies.set('usa', new Lobby('usa','America', true));
// pre-fill pickups in defaults
lobbies.get('aus').spawnInitialPickups();
lobbies.get('usa').spawnInitialPickups();

/* === Broadcast helpers === */
function broadcastAll(obj){
  const data = JSON.stringify(obj);
  wss.clients.forEach(c => {
    if(c.readyState === WebSocket.OPEN) c.send(data);
  });
}
function broadcastLobby(lobby, obj){
  const data = JSON.stringify(obj);
  lobby.players.forEach(p => {
    if(p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
  });
}

/* === Server: connection handling === */
wss.on('connection', ws => {
  const playerId = nextId();
  let myLobby = null;
  let myPlayer = null;

  // send welcome & lobby list
  ws.send(JSON.stringify({type:'welcome', playerId}));
  sendLobbyList();

  ws.on('message', raw => {
    let msg;
    try{ msg = JSON.parse(raw); } catch(e){ ws.send(JSON.stringify({type:'error', msg:'bad json'})); return; }
    switch(msg.type){
      case 'createLobby': {
        if(myLobby) { ws.send(JSON.stringify({type:'error', msg:'already in lobby'})); break;}
        const lid = nextId();
        const lobby = new Lobby(lid,'Custom',false);
        lobbies.set(lid, lobby);
        myLobby = lobby;
        const name = (msg.name && msg.name.trim()) ? msg.name.trim() : `Player-${playerId.slice(0,4)}`;
        myPlayer = {
          id: playerId, ws,
          x:0, y:0, rot:0,
          hp: PLAYER_MAX_HP, kills:0,
          weapon: 'pistol', lastShot:0,
          speedMultiplier:1, speedExpire:0,
          name,
        };
        // spawn player random
        spawnPlayerAtRandom(lobby, myPlayer);
        lobby.players.set(playerId, myPlayer);
        ws.send(JSON.stringify({type:'lobbyCreated', lobbyId: lid, killsToWin: lobby.killsToWin, host: true}));
        broadcastLobby(lobby, {type:'players', players: serializePlayers(lobby)});
        sendLobbyList();
        break;
      }
      case 'joinLobby': {
        if(myLobby){ ws.send(JSON.stringify({type:'error', msg:'already in lobby'})); break;}
        const lid = msg.lobbyId;
        const lobby = lobbies.get(lid);
        if(!lobby){ ws.send(JSON.stringify({type:'error', msg:'lobby not found'})); break;}
        // allow join even if gameStarted for alwaysOpen lobbies
        if(lobby.gameStarted && !lobby.alwaysOpen){
          ws.send(JSON.stringify({type:'error', msg:'game started'})); break;
        }
        myLobby = lobby;
        const name = (msg.name && msg.name.trim()) ? msg.name.trim() : `Player-${playerId.slice(0,4)}`;
        myPlayer = {
          id: playerId, ws,
          x:0, y:0, rot:0,
          hp: PLAYER_MAX_HP, kills:0,
          weapon: 'pistol', lastShot:0,
          speedMultiplier:1, speedExpire:0,
          name,
        };
        spawnPlayerAtRandom(lobby, myPlayer);
        lobby.players.set(playerId, myPlayer);
        // reply with lobby info incl obstacles & pickups
        ws.send(JSON.stringify({
          type:'lobbyJoined',
          lobbyId: lid,
          killsToWin: lobby.killsToWin,
          host: false,
          gameStarted: lobby.gameStarted,
          obstacles,
          pickups: lobby.pickups,
          weapons: Object.values(WEAPONS).map(w=>({id:w.id,name:w.name})),
        }));
        broadcastLobby(lobby, {type:'players', players: serializePlayers(lobby)});
        sendLobbyList();
        break;
      }
      case 'startGame': {
        if(!myLobby) break;
        // simple: allow start for custom lobby; host enforcement omitted for brevity
        myLobby.gameStarted = true;
        broadcastLobby(myLobby, {type:'gameStarted'});
        sendLobbyList();
        break;
      }
      case 'updateState': {
        if(!myLobby || !myPlayer) break;
        // Accept X,Y,rot,kills (client authoritative for movement but server clamps)
        const nx = typeof msg.x === 'number' ? clamp(msg.x, -MAP_SIZE, MAP_SIZE) : myPlayer.x;
        const ny = typeof msg.y === 'number' ? clamp(msg.y, -MAP_SIZE, MAP_SIZE) : myPlayer.y;
        const nrot = typeof msg.rot === 'number' ? msg.rot : myPlayer.rot;
        // collision with obstacles: reject movement if colliding
        const coll = obstacles.some(o => circleRectColliding(nx, ny, PLAYER_RADIUS, o.x, o.y, o.w, o.h));
        if(!coll){
          myPlayer.x = nx; myPlayer.y = ny;
        }
        myPlayer.rot = nrot;
        // if client sends kills (not used), ignore
        break;
      }
      case 'shoot': {
        if(!myLobby || !myPlayer) break;
        const nowTs = now();
        const weapon = WEAPONS[myPlayer.weapon] || WEAPONS.pistol;
        if(nowTs - (myPlayer.lastShot||0) < weapon.cooldown) break;
        myPlayer.lastShot = nowTs;
        // spawn bullets according to weapon
        for(let i=0;i<weapon.bulletsPerShot;i++){
          const spread = weapon.spread || 0;
          const angle = myPlayer.rot + ((Math.random()-0.5) * spread);
          const speed =  (weapon.id === 'shotgun') ? 35 : 50;
          const bx = myPlayer.x + Math.sin(angle)*(PLAYER_RADIUS+0.5);
          const by = myPlayer.y + Math.cos(angle)*(PLAYER_RADIUS+0.5);
          const vx = Math.sin(angle) * speed;
          const vy = Math.cos(angle) * speed;
          myLobby.bullets.push({
            id: nextId(),
            x: bx, y: by, vx, vy,
            ownerId: playerId, damage: weapon.damage
          });
        }
        break;
      }
      case 'leaveLobby': {
        if(myLobby && myLobby.players.has(playerId)){
          myLobby.players.delete(playerId);
          broadcastLobby(myLobby, {type:'players', players: serializePlayers(myLobby)});
          if(!myLobby.alwaysOpen && myLobby.players.size===0){
            lobbies.delete(myLobby.id);
          }
          sendLobbyList();
        }
        myLobby = null; myPlayer = null;
        break;
      }
      default:
        ws.send(JSON.stringify({type:'error', msg:'unknown type'}));
    }
  });

  ws.on('close', () => {
    if(myLobby && myLobby.players.has(playerId)){
      myLobby.players.delete(playerId);
      broadcastLobby(myLobby, {type:'players', players: serializePlayers(myLobby)});
      if(!myLobby.alwaysOpen && myLobby.players.size===0){
        lobbies.delete(myLobby.id);
      }
      sendLobbyList();
    }
  });
});

/* === spawn helpers === */
function spawnPlayerAtRandom(lobby, player){
  let tries=0;
  while(tries++ < 200){
    const x = randRange(-MAP_SIZE, MAP_SIZE);
    const y = randRange(-MAP_SIZE, MAP_SIZE);
    if(obstacles.some(o => circleRectColliding(x,y,PLAYER_RADIUS, o.x,o.y,o.w,o.h))) continue;
    player.x = x; player.y = y;
    player.rot = Math.random()*Math.PI*2;
    player.hp = PLAYER_MAX_HP;
    player.speedMultiplier = 1;
    player.speedExpire = 0;
    player.kills = player.kills || 0;
    player.weapon = player.weapon || 'pistol';
    return;
  }
  player.x = 0; player.y = 0; player.rot = 0; player.hp = PLAYER_MAX_HP;
}

/* === lobby list broadcast === */
function sendLobbyList(){
  const list = [];
  for(const [id,l] of lobbies.entries()){
    list.push({
      id: l.id,
      playersCount: l.players.size,
      killsToWin: l.killsToWin,
      gameStarted: l.gameStarted,
      region: l.region,
      alwaysOpen: l.alwaysOpen || false,
    });
  }
  broadcastAll({type:'lobbyList', lobbies: list});
}

/* === Game loop: bullets, pickups, respawn, collisions === */
setInterval(() => {
  const t0 = now();
  for(const lobby of lobbies.values()){
    // spawn pickups periodically
    if(t0 - lobby.lastPickupSpawn > PICKUP_SPAWN_INTERVAL){
      lobby.spawnPickupRandom();
      lobby.lastPickupSpawn = t0;
    }

    if(!lobby.gameStarted) continue;

    // Advance bullets (fixed step)
    const step = TICK_MS/1000;
    const removeBulletIdx = new Set();
    for(let i=0;i<lobby.bullets.length;i++){
      const b = lobby.bullets[i];
      b.x += b.vx * step;
      b.y += b.vy * step;
      // bullet out of map
      if(Math.abs(b.x) > MAP_SIZE || Math.abs(b.y) > MAP_SIZE) { removeBulletIdx.add(i); continue; }
      // bullet hits obstacle?
      if(obstacles.some(o => circleRectColliding(b.x,b.y,BULLET_RADIUS, o.x,o.y,o.w,o.h))){ removeBulletIdx.add(i); continue; }
      // check hit players
      for(const [pid,p] of lobby.players.entries()){
        if(pid === b.ownerId) continue;
        if(p.hp <= 0) continue;
        if(circleCircle(b.x,b.y,BULLET_RADIUS, p.x,p.y, PLAYER_RADIUS)){
          // damage
          p.hp -= b.damage;
          removeBulletIdx.add(i);
          if(p.hp <= 0){
            p.hp = 0;
            // killer scoring
            const killer = lobby.players.get(b.ownerId);
            if(killer){
              killer.kills = (killer.kills||0) + 1;
              // broadcast kill
              broadcastLobby(lobby, {type:'playerKilled', killerId: killer.id, victimId: p.id});
              // check win
              if(killer.kills >= lobby.killsToWin){
                broadcastLobby(lobby, {type:'gameOver', winnerId:killer.id});
                // reset kills and hp and respawn everyone
                for(const [,pl] of lobby.players){
                  pl.kills = 0; pl.hp = PLAYER_MAX_HP;
                  spawnPlayerAtRandom(lobby, pl);
                }
              }
            }
            // schedule respawn for victim
            setTimeout(()=> {
              if(!lobby.players.has(p.id)) return;
              const respawnP = lobby.players.get(p.id);
              respawnP.hp = PLAYER_MAX_HP;
              spawnPlayerAtRandom(lobby, respawnP);
              broadcastLobby(lobby, {type:'players', players: serializePlayers(lobby)});
            }, RESPAWN_MS);
          }
          break;
        }
      }
    }
    // remove bullets in reverse order
    const idxs = Array.from(removeBulletIdx).sort((a,b)=>b-a);
    for(const idx of idxs) lobby.bullets.splice(idx,1);

    // Player pickups collisions (server authoritative)
    for(const pickup of [...lobby.pickups]){
      for(const [,p] of lobby.players){
        if(p.hp <= 0) continue;
        if(circleCircle(p.x,p.y,PLAYER_RADIUS+0.2, pickup.x,pickup.y,0.8)){
          // apply pickup
          if(pickup.type === 'gun'){
            p.weapon = pickup.subType;
            // optional: give small ammo-like effect — here unlimited
            // broadcast pickup event only for visual
            broadcastLobby(lobby, {type:'pickupTaken', playerId: p.id, pickupId: pickup.id});
          } else if(pickup.type === 'power'){
            if(pickup.subType === 'health'){
              p.hp = Math.min(PLAYER_MAX_HP, p.hp + 40);
            } else if(pickup.subType === 'speed'){
              p.speedMultiplier = 1.8;
              p.speedExpire = now() + 10000; // 10s
              // server will decay later
            }
            broadcastLobby(lobby, {type:'pickupTaken', playerId: p.id, pickupId: pickup.id});
          }
          // remove pickup from lobby
          const ix = lobby.pickups.findIndex(pp => pp.id === pickup.id);
          if(ix >= 0) lobby.pickups.splice(ix,1);
          break;
        }
      }
    }

    // expire speed powerups
    for(const [,p] of lobby.players){
      if(p.speedMultiplier > 1 && p.speedExpire && now() > p.speedExpire){
        p.speedMultiplier = 1; p.speedExpire = 0;
      }
    }

    // broadcast state (players, bullets, pickups, obstacles)
    const payload = {
      type: 'players',
      players: serializePlayers(lobby),
      bullets: lobby.bullets,
      pickups: lobby.pickups,
      obstacles,
    };
    broadcastLobby(lobby, payload);
  }
}, TICK_MS);

/* === helper to serialize players === */
function serializePlayers(lobby){
  const arr = [];
  for(const [id,p] of lobby.players.entries()){
    arr.push({
      id: p.id, x: p.x, y: p.y, rot: p.rot,
      hp: p.hp, kills: p.kills, name: p.name,
      weapon: p.weapon,
    });
  }
  return arr;
}

/* === utils for lobby spawn initial pickups === */
for(const l of lobbies.values()){
  l.spawnInitialPickups?.();
}
