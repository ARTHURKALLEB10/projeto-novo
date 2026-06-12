const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys')
const express  = require('express')
const { createServer } = require('http')
const { Server } = require('socket.io')
const qrcode   = require('qrcode')
const path     = require('path')
const fs       = require('fs')
const { exec } = require('child_process')
const P        = require('pino')
const { createClient } = require('@supabase/supabase-js')

// Supabase service_role para criar usuários pelo admin
// Configure as variáveis de ambiente SUPABASE_URL e SUPABASE_SERVICE_KEY
const sbAdmin = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  : null

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

      // Salva QR como imagem e abre automaticamente
      const qrFile = path.join(__dirname, 'qrcode.png')
      await qrcode.toFile(qrFile, qr, { scale: 10, margin: 2 })
      console.log('🖼  QR Code salvo em: ' + qrFile)
      // Abre a imagem no visualizador padrão do Windows
      exec(`start "" "${qrFile}"`)
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

  // Carrega lista de chats existentes quando conecta
  sock.ev.on('chats.set', ({ chats: chatList }) => {
    chatList.forEach(chat => {
      const jid = chat.id
      if (!jid || jid.endsWith('@g.us') || jid.endsWith('@broadcast')) return
      const phone = jid.replace('@s.whatsapp.net','')
      if (!contacts[jid]) {
        contacts[jid] = { jid, name: chat.name || `+${phone}`, phone, lastMsg: '', lastTs: '' }
      }
    })
    if (Object.keys(contacts).length) io.emit('contacts-update', Object.values(contacts))
    console.log(`📋 ${Object.keys(contacts).length} contatos carregados`)
  })

  // Mensagens recebidas e enviadas
  sock.ev.on('messages.upsert', async ({ messages: msgs, type }) => {
    if (type !== 'notify') return

    for (const msg of msgs) {
      const jid     = msg.key.remoteJid
      const isGroup = jid.endsWith('@g.us')
      if (isGroup) continue

      const text = msg.message?.conversation
        || msg.message?.extendedTextMessage?.text
        || msg.message?.imageMessage?.caption
        || msg.message?.videoMessage?.caption
        || (msg.message?.imageMessage ? '[Imagem]' : null)
        || (msg.message?.audioMessage ? '[Áudio]' : null)
        || (msg.message?.documentMessage ? '[Documento]' : null)
        || '[Mensagem]'

      const phone = jid.replace('@s.whatsapp.net', '')
      const name  = msg.pushName || contacts[jid]?.name || `+${phone}`
      const ts    = new Date(msg.messageTimestamp * 1000)
        .toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
      const rx    = !msg.key.fromMe

      if (!messages[jid]) messages[jid] = []
      messages[jid].push({ rx, text, ts, pushName: rx ? name : undefined })

      // Atualizar contato (somente para mensagens recebidas preserva o pushName)
      if (rx) {
        contacts[jid] = { jid, name, phone, lastMsg: text, lastTs: ts }
        io.emit('new-message', { jid, name, phone, text, ts })
        io.emit('contacts-update', Object.values(contacts))
      }
    }
  })
}

// ─── API REST ───
app.get('/api/status',         (req, res) => res.json({ connected: waConnected, phone: connectedPhone }))
app.get('/api/messages/:jid',  (req, res) => res.json(messages[req.params.jid] || []))
app.get('/api/contacts',       (req, res) => res.json(Object.values(contacts)))

// Endpoint de teste — envia mensagem direto pelo servidor
app.post('/api/send', async (req, res) => {
  const { phone, text } = req.body
  if (!sock || !waConnected) return res.status(503).json({ error: 'WhatsApp não conectado' })
  try {
    const cleanPhone = String(phone).replace(/\D/g,'')
    const jid = `${cleanPhone}@s.whatsapp.net`
    await sock.sendMessage(jid, { text })
    console.log(`✅ API /api/send → ${jid}: ${text}`)
    res.json({ ok: true, jid })
  } catch (e) {
    console.error('❌ /api/send erro:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// Criar usuário via admin (requer SUPABASE_SERVICE_KEY)
app.post('/api/create-user', async (req, res) => {
  if (!sbAdmin) return res.status(503).json({ error: 'SUPABASE_SERVICE_KEY não configurada no servidor.' })
  const { nome, email, password, role } = req.body
  if (!nome || !email || !password || !role) return res.status(400).json({ error: 'Campos obrigatórios faltando.' })
  const { data, error } = await sbAdmin.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { nome, role }
  })
  if (error) return res.status(400).json({ error: error.message })
  res.json({ ok: true, id: data.user?.id })
})

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
      // Garante JID completo com sufixo correto
      const phone   = jid.replace('@s.whatsapp.net','').replace(/\D/g,'')
      const fullJid = `${phone}@s.whatsapp.net`

      console.log(`📤 Enviando para ${fullJid}: "${text}"`)
      await sock.sendMessage(fullJid, { text })

      const ts = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
      if (!messages[fullJid]) messages[fullJid] = []
      messages[fullJid].push({ rx: false, text, ts })

      if (!contacts[fullJid]) contacts[fullJid] = { jid: fullJid, name: `+${phone}`, phone }
      contacts[fullJid].lastMsg = text
      contacts[fullJid].lastTs  = ts

      socket.emit('message-sent', { jid: fullJid, text, ts })
      console.log(`✅ Mensagem entregue a ${fullJid}`)
    } catch (e) {
      console.error(`❌ Falha ao enviar para ${jid}:`, e.message)
      socket.emit('send-error', e.message)
    }
  })

  // Buscar histórico de um contato
  socket.on('get-messages', (jid) => {
    socket.emit('message-history', { jid, messages: messages[jid] || [] })
  })

  // Reconectar WhatsApp a pedido do cliente
  socket.on('wa-connect-request', () => {
    if (!waConnected) startWA()
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
