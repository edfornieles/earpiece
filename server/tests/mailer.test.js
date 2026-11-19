const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const m = require('../mailer');

// A pretend mail server that speaks just enough SMTP and keeps what it was sent.
function fakeSmtp(t, { refuseLogin = false } = {}) {
  const got = { lines: [], data: '' };
  const srv = net.createServer((s) => {
    let buf = '', inData = false;
    s.on('error', () => {});
    s.write('220 fake ready\r\n');
    s.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) { if (line === '.') { inData = false; s.write('250 2.0.0 queued\r\n'); } else got.data += line + '\r\n'; continue; }
        got.lines.push(line);
        if (line.startsWith('EHLO')) s.write('250-fake\r\n250-AUTH PLAIN\r\n250 SMTPUTF8\r\n');
        else if (line.startsWith('AUTH')) s.write(refuseLogin ? '535 5.7.8 Username and Password not accepted\r\n' : '235 ok\r\n');
        else if (line === 'DATA') { inData = true; s.write('354 go ahead\r\n'); }
        else if (line === 'QUIT') { s.write('221 bye\r\n'); s.end(); }
        else s.write('250 ok\r\n');
      }
    });
  });
  t.after(() => srv.close());
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ got, connect: () => net.connect(srv.address().port, '127.0.0.1') })));
}

test('the welcome email names the person, their address, their role, who invited them and the link', () => {
  const w = m.welcomeEmail({ name: 'Nina', email: 'nina@example.com', role: 'director', inviter: 'Ed', link: 'https://mother.example' });
  assert.equal(w.subject, 'Ed has invited you to direct Mother');
  assert.match(w.text, /^Hi Nina,/); assert.match(w.text, /nina@example\.com/); assert.match(w.text, /https:\/\/mother\.example/);
  assert.match(w.text, /added as a director\./); assert.doesNotMatch(w.text, /\{\w+\}|^Subject:/m);
  assert.match(m.welcomeEmail({ email: 'o@x.com', role: 'owner' }).text, /an owner/);
  assert.equal(m.welcomeEmail({}, 'No subject line here').subject, 'Welcome to Mother');
});

test('sends over SMTP: signs in, addresses it, and the body arrives intact with accents', async (t) => {
  const { got, connect } = await fakeSmtp(t);
  await m.sendMail({ to: 'nina@example.com', subject: 'Bienvenue, Zoë', text: 'Hi Zoë,\n.leading dot line\nbye\n' }, { user: 'ed@gmail.com', pass: 'app pass', connect });
  assert.ok(got.lines.includes('MAIL FROM:<ed@gmail.com>')); assert.ok(got.lines.includes('RCPT TO:<nina@example.com>'));
  assert.equal(Buffer.from(got.lines.find((l) => l.startsWith('AUTH PLAIN')).slice(11), 'base64').toString(), '\0ed@gmail.com\0app pass');
  const [head, body] = got.data.split('\r\n\r\n');
  assert.match(head, /^Subject: =\?UTF-8\?B\?/m); assert.match(head, /^From: Mother <ed@gmail\.com>/m);
  assert.equal(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString(), 'Hi Zoë,\r\n.leading dot line\r\nbye\r\n');
});

test('a refused Gmail sign-in, missing settings or a bad address give a clear reason', async (t) => {
  const { connect } = await fakeSmtp(t, { refuseLogin: true });
  await assert.rejects(m.sendMail({ to: 'a@b.com', subject: 's', text: 't' }, { user: 'ed@gmail.com', pass: 'wrong', connect }), /app password/);
  await assert.rejects(m.sendMail({ to: 'a@b.com', subject: 's', text: 't' }, {}), /GMAIL_USER/);
  await assert.rejects(m.sendMail({ to: 'not an address', subject: 's', text: 't' }, { user: 'ed@gmail.com', pass: 'p', connect }), /Not an email/);
});
