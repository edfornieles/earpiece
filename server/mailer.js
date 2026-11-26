// Email from Mother: the welcome note sent when someone is added to the team.
//
// Sent through Gmail (smtp.gmail.com, TLS on port 465) as the account in GMAIL_USER, with a Google app
// password in GMAIL_APP_PASSWORD (myaccount.google.com/apppasswords; needs 2-step verification). Replies go
// to that inbox. Plain SMTP is spoken directly here, so there is nothing extra to install.
//
// The note's wording lives in welcome-email.txt next to this file when it has been edited on the Team page
// (not in git); otherwise DEFAULT_WELCOME below. The first line is the subject.
const tls = require('tls');
const crypto = require('crypto');

const DEFAULT_WELCOME = `Subject: {inviter} has invited you to direct Mother

Hi {name},

{inviter} has added you to the team for Mother.

Mother is a live performance. Each participant wears an earpiece, and a voice called Mother speaks in their ear and guides them around a studio while cameras watch. Behind it is a control room, the desk, where human directors and an AI director work together: listening to each participant, speaking to them live, typing lines for Mother to say, and following them on the studio cameras. Every visit is recorded and kept in an archive.

As a director you can join the desk from anywhere.

How to sign in
1. On a computer, open {link}
2. Choose Sign in with Google and use this address: {email}
   It has to be this exact address. Other addresses are not on the list.
3. You arrive at the Live desk. Put on headphones, press Enable sound to listen, and Enable microphone when you want to talk to a participant.

You have been added as {role}.

If anything does not work, just reply to this email.

Mother`;

// Fill in a template. Returns { subject, text }.
function welcomeEmail({ name = '', email = '', role = 'director', inviter = '', link = '' } = {}, template = DEFAULT_WELCOME) {
  const roles = { owner: 'an owner: you can also manage the team and switch privacy mode', director: 'a director' };
  const vars = { name: name || email.split('@')[0] || 'there', email, role: roles[role] || roles.director, inviter: inviter || 'The Mother team', link };
  const filled = String(template).replace(/\{(name|email|role|inviter|link)\}/g, (_, k) => vars[k]).replace(/\r\n/g, '\n');
  const m = filled.match(/^Subject:[ \t]*(.*)\n+/i);
  return { subject: (m ? m[1] : 'Welcome to Mother').trim(), text: (m ? filled.slice(m[0].length) : filled).trim() + '\n' };
}

const header = (s) => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`;
const addr = (s) => { const a = String(s || '').trim(); if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(a)) throw Error('Not an email address: ' + a); return a; };

// The message itself: plain text, UTF-8, base64 so long lines and accents survive.
function message({ from, fromName = 'Mother', to, subject, text, now = new Date() }) {
  const body = Buffer.from(text.replace(/\r?\n/g, '\r\n')).toString('base64').replace(/.{76}/g, '$&\r\n');
  return [`From: ${header(fromName)} <${from}>`, `To: <${to}>`, `Reply-To: <${from}>`, `Subject: ${header(subject)}`, `Date: ${now.toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${from.split('@')[1]}>`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', body].join('\r\n');
}

// Send one email over SMTP. connect() is replaceable for tests.
function sendMail({ to, subject, text }, { user, pass, fromName = 'Mother', host = 'smtp.gmail.com', port = 465, timeout = 20000, connect } = {}) {
  if (!user || !pass) return Promise.reject(Error('Email is not set up: add GMAIL_USER and GMAIL_APP_PASSWORD to server/.env and restart Mother.'));
  let from; try { from = addr(user); to = addr(to); } catch (e) { return Promise.reject(e); }
  return new Promise((resolve, reject) => {
    const sock = connect ? connect() : tls.connect({ host, port, servername: host });
    let buf = '', waiting = null, done = false;
    const finish = (err, v) => { if (done) return; done = true; clearTimeout(timer); sock.destroy(); err ? reject(err) : resolve(v); };
    const timer = setTimeout(() => finish(Error('The mail server did not answer in time.')), timeout);
    sock.setEncoding('utf8');
    sock.on('error', (e) => finish(Error('Could not reach the mail server: ' + e.message)));
    sock.on('close', () => finish(Error('The mail server closed the connection.')));
    sock.on('data', (d) => {
      buf += d;
      for (;;) {   // a reply ends on a line "NNN text" (a dash after the code means more lines follow)
        const lines = buf.split('\r\n'), i = lines.findIndex((l) => /^\d{3}(?: |$)/.test(l));
        if (i < 0 || i === lines.length - 1 && !buf.endsWith('\r\n')) break;
        const reply = lines.slice(0, i + 1).join('\n'); buf = lines.slice(i + 1).join('\r\n');
        const w = waiting; waiting = null; if (w) w(reply);
      }
    });
    const step = (line, want) => new Promise((ok) => { waiting = ok; if (line != null) sock.write(line + '\r\n'); }).then((reply) => {
      if (!String(reply).startsWith(want)) throw Object.assign(Error(reply.split('\n').pop().replace(/^\d{3}[ -]?/, '')), { code: +reply.slice(0, 3) });
      return reply;
    });
    const data = message({ from, fromName, to, subject, text }).replace(/^\./gm, '..');
    (async () => {
      await step(null, '220');
      await step('EHLO mother.local', '250');
      await step('AUTH PLAIN ' + Buffer.from(`\0${from}\0${pass}`).toString('base64'), '235').catch((e) => {
        throw Error(e.code === 535 ? 'Gmail refused the sign-in. Check GMAIL_USER and that GMAIL_APP_PASSWORD is an app password, not your normal password.' : e.message);
      });
      await step(`MAIL FROM:<${from}>`, '250');
      await step(`RCPT TO:<${to}>`, '25');
      await step('DATA', '354');
      const r = await step(data + '\r\n.', '250');
      await Promise.race([step('QUIT', '221').catch(() => {}), new Promise((ok) => setTimeout(ok, 2000))]);   // sent already; just say goodbye politely
      finish(null, { to, reply: r });
    })().catch((e) => finish(e));
  });
}

module.exports = { DEFAULT_WELCOME, welcomeEmail, message, sendMail };
