const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys')
const express  = require('express')
const { createServer } = require('http')
const { Server } = require('socket.io')
const qrcode   = require('qrcode')
const path     = require('path')
const P        = require('pino')

const app        = express()
const httpServer = createServer(app)
const io         = new Server(httpServer, { cors: { origin: '*' } })

app.use(express.static(path.join(__dirname)))
app.use(express.json())

// ─── Estado global ───
let sock           = null
let qrData         = null
let waConnected    = false
let connectedPhone = null

// Mensagens por JID: { jid: [{rx, text, ts, pushName}] }
const messages  = {}
// Contatos vistos: { jid: { name, phone, lastMsg, lastTs } }
const contacts  = {}

// ─── Iniciar WhatsApp ───
async function startWA() {
  const { state, saveCreds } = await useMultiFileAuthState('wa-auth')
  const { version }          = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth:                         state,
    logger:                       P({ level: 'silent' }),
    printQRInTerminal:            true,
    generateHighQualityLinkPreview: false,
    browser:                      ['ABA Edu', 'Chrome', '1.0.0'],
  })

  // QR / Conexão
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrData = await qrcode.toDataURL(qr, { scale: 7, margin: 2 })
      io.emit('qr', qrData)
      waConnected = false
      io.emit('wa-status', { connected: false, waiting: true })
      console.log('📱 QR Code gerado — aponte a câmera do WhatsApp')
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      waConnected    = false
      qrData         = null
      connectedPhone = null
      io.emit('wa-status', { connected: false })
      if (code !== DisconnectReason.loggedOut) {
        console.log('🔄 Reconectando...')
        setTimeout(startWA, 3000)
      } else {
        console.log('🔓 Sessão encerrada. Exclua a pasta wa-auth para escanear novamente.')
      }
    }

    if (connection === 'open') {
      waConnected    = true
      qrData         = null
      connectedPhone = sock.user?.id?.split(':')[0] || sock.user?.id
      io.emit('wa-status', { connected: true, phone: connectedPhone })
      io.emit('qr-done')
      console.log(`\n✅ WhatsApp conectado: +${connectedPhone}\n`)
    }
  })

  sock.ev.on('creds.update', saveCreds)

  // Mensagens recebidas
  sock.ev.on('messages.upsert', async ({ messages: msgs, type }) => {
    if (type !== 'notify') return

    for (const msg of msgs) {
      if (msg.key.fromMe) continue

      const jid      = msg.key.remoteJid
      const isGroup  = jid.endsWith('@g.us')
      if (isGroup) continue // ignorar grupos por enquanto

      const text = msg.message?.conversation
        || msg.message?.extendedTextMessage?.text
        || msg.message?.imageMessage?.caption
        || msg.message?.videoMessage?.caption
        || (msg.message?.imageMessage ? '[Imagem]' : null)
        || (msg.message?.audioMessage ? '[Áudio]' : null)
        || (msg.message?.documentMessage ? '[Documento]' : null)
        || '[Mensagem]'

      const phone   = jid.replace('@s.whatsapp.net', '')
      const name    = msg.pushName || `+${phone}`
      const ts      = new Date(msg.messageTimestamp * 1000)
        .toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })

      // Salvar mensagem
      if (!messages[jid]) messages[jid] = []
      messages[jid].push({ rx: true, text, ts, pushName: name })

      // Atualizar contato
      contacts[jid] = { jid, name, phone, lastMsg: text, lastTs: ts }

      // Emitir para o frontend
      io.emit('new-message', { jid, name, phone, text, ts })
      io.emit('contacts-update', Object.values(contacts))
    }
  })

  // Mensagens enviadas pelo próprio número (confirmação)
  sock.ev.on('messages.upsert', async ({ messages: msgs }) => {
    for (const msg of msgs) {
      if (!msg.key.fromMe) continue
      const jid = msg.key.remoteJid
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || ''
      if (!text) continue
      const ts = new Date(msg.messageTimestamp * 1000)
        .toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
      if (!messages[jid]) messages[jid] = []
      messages[jid].push({ rx: false, text, ts })
    }
  })
}

// ─── API REST ───
app.get('/api/status',         (req, res) => res.json({ connected: waConnected, phone: connectedPhone }))
app.get('/api/messages/:jid',  (req, res) => res.json(messages[req.params.jid] || []))
app.get('/api/contacts',       (req, res) => res.json(Object.values(contacts)))

app.post('/api/logout', async (req, res) => {
  if (sock) { try { await sock.logout() } catch (e) {} }
  waConnected = false; qrData = null; connectedPhone = null
  res.json({ ok: true })
})

// ─── Socket.io ───
io.on('connection', (socket) => {
  // Envia estado atual para quem acabou de conectar
  socket.emit('wa-status', { connected: waConnected, phone: connectedPhone })
  if (qrData)                        socket.emit('qr', qrData)
  if (Object.keys(contacts).length)  socket.emit('contacts-update', Object.values(contacts))

  // Enviar mensagem
  socket.on('send-message', async ({ jid, text }) => {
    if (!sock || !waConnected) {
      socket.emit('send-error', 'WhatsApp não está conectado')
      return
    }
    try {
      const fullJid = jid.includes('@') ? jid : `${jid}@s.whatsapp.net`
      await sock.sendMessage(fullJid, { text })
      const ts = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
      if (!messages[fullJid]) messages[fullJid] = []
      messages[fullJid].push({ rx: false, text, ts })
      socket.emit('message-sent', { jid: fullJid, text, ts })
    } catch (e) {
      socket.emit('send-error', e.message)
    }
  })

  // Buscar histórico de um contato
  socket.on('get-messages', (jid) => {
    socket.emit('message-history', { jid, messages: messages[jid] || [] })
  })

  // Desconectar WhatsApp
  socket.on('wa-logout', async () => {
    if (sock) { try { await sock.logout() } catch (e) {} }
    waConnected = false; qrData = null; connectedPhone = null
    io.emit('wa-status', { connected: false })
  })
})

// ─── Start ───
startWA()

const PORT = process.env.PORT || 3000
httpServer.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════╗')
  console.log(`║  🎓 ABA Edu  →  http://localhost:${PORT}  ║`)
  console.log('╚══════════════════════════════════════╝')
  console.log('\n📱 Aguardando QR Code do WhatsApp...')
  console.log('   Abra o site e clique em "Conectar WhatsApp"\n')
})
