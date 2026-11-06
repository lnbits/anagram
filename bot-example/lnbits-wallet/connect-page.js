// The connection page: static HTML, CSS and a small script, with no third-party code and no
// browser storage. The script takes the one-time token from the URL fragment (which never
// reaches server logs or referrers), removes it from the address bar and uses textContent
// only, so nothing a server or person supplied is ever parsed as HTML.
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Connect a wallet</title>
<link rel="stylesheet" href="/c/app.css">
</head>
<body>
<main>
<h1>Connect a wallet</h1>
<p id="status" role="status" aria-live="polite">Checking your link…</p>
<p id="error" class="error" role="alert" hidden></p>

<section id="choose" hidden>
  <p>This wallet will be connected to the Nostr account <strong id="account"></strong>.
  Only continue if that is <strong>your own</strong> account. If someone sent you this link, close this page.</p>
  <h2>How would you like to connect?</h2>
  <div id="kinds"></div>
</section>

<section id="lnbits" hidden>
  <h2>Connect an LNbits wallet</h2>
  <p class="note"><strong>Receive only.</strong> The bot will be able to see this wallet's balance and history and to create invoices. It cannot spend.</p>
  <form id="lnbits-form" autocomplete="off">
    <label for="url">LNbits address</label>
    <input id="url" type="url" inputmode="url" placeholder="https://lnbits.example" required spellcheck="false" autocapitalize="off">
    <label for="key">Invoice key</label>
    <input id="key" type="password" required spellcheck="false" autocapitalize="off" autocomplete="off">
    <p class="hint">In LNbits, open your wallet, then <em>Node URL, API keys and API docs</em>, and copy the <strong>Invoice/read key</strong>. <strong>Never use the Admin key</strong>: it can spend your funds, and this page will refuse it.</p>
    <label for="label">Name for this wallet (optional)</label>
    <input id="label" type="text" maxlength="40" placeholder="Savings" autocomplete="off">
    <button type="submit">Continue</button>
  </form>
</section>

<section id="nwc" hidden>
  <h2>Connect with Nostr Wallet Connect</h2>
  <p class="note" id="nwc-receive"><strong>Receive only.</strong> Create a new connection in your wallet that can only read your balance and history and create invoices. A connection that can spend will be refused.</p>
  <p class="note" id="nwc-spend" hidden><strong>This connection can spend your funds.</strong> Create a new connection in your wallet and <strong>set a spending limit there</strong>: the wallet enforces it, and this page refuses a connection without one. Allow only paying invoices, reading your balance, budget and history, and creating invoices. Every payment asks you to confirm in the chat first.</p>
  <form id="nwc-form" autocomplete="off">
    <label for="connection">Connection string</label>
    <input id="connection" type="password" required spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="nostr+walletconnect://...">
    <p class="hint">Your wallet shows this when you create the connection. Treat it like a password: paste it only here, never in a chat.</p>
    <label for="nwc-label">Name for this wallet (optional)</label>
    <input id="nwc-label" type="text" maxlength="40" autocomplete="off">
    <label id="ack-row" class="check" hidden><input id="ack" type="checkbox"> I understand that this connection can spend my funds, up to the limit set in my wallet. Anyone controlling my Nostr account could ask for payments.</label>
    <button type="submit">Continue</button>
  </form>
</section>

<section id="code" hidden>
  <h2>Confirm it is you</h2>
  <p>The bot has just sent a code to your Nostr account. Open your chat with the bot in Anagram and type the code here. This wallet is not connected until you do.</p>
  <div id="granted" hidden>
    <p><strong>This connection allows the bot to:</strong></p>
    <ul id="permissions"></ul>
    <p id="limit" class="note" hidden></p>
  </div>
  <p>Connecting <strong id="target"></strong> to the Nostr account <strong id="account-again"></strong>. That must be <strong>your own</strong> account. If someone else gave you this code or told you what to type, stop and press Cancel: they would get access to your wallet.</p>
  <form id="code-form" autocomplete="off">
    <label for="confirm">Code from your chat</label>
    <input id="confirm" type="text" required spellcheck="false" autocapitalize="characters" autocomplete="one-time-code" placeholder="XXXX-XXXX">
    <button type="submit">Connect this wallet</button>
  </form>
</section>

<section id="done" hidden>
  <h2>Connected</h2>
  <p>You can close this page and go back to Anagram. The bot has confirmed it in your chat.</p>
</section>

<button id="cancel" type="button" class="secondary" hidden>Cancel</button>
</main>
<script src="/c/app.js"></script>
</body>
</html>
`;

export const STYLE = `:root { color-scheme: light dark; --accent: #2f6fdb; --line: #8888; }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.5 system-ui, sans-serif; }
main { max-width: 32rem; margin: 0 auto; padding: 1.25rem 1rem 3rem; }
h1 { font-size: 1.5rem; margin: 0 0 .75rem; }
h2 { font-size: 1.15rem; margin: 1.25rem 0 .5rem; }
label { display: block; font-weight: 600; margin: 1rem 0 .25rem; }
input { width: 100%; padding: .7rem; font: inherit; border: 1px solid var(--line); border-radius: .5rem; background: transparent; color: inherit; }
button { display: block; width: 100%; margin-top: 1rem; padding: .8rem; min-height: 44px; font: inherit; font-weight: 600; color: #fff; background: var(--accent); border: 0; border-radius: .5rem; cursor: pointer; }
button:disabled { opacity: .6; cursor: progress; }
button.secondary { color: inherit; background: transparent; border: 1px solid var(--line); }
.note { padding: .75rem; border: 1px solid var(--line); border-radius: .5rem; }
.hint { font-size: .9rem; margin: .4rem 0 0; }
.error { color: #c0392b; font-weight: 600; }
label.check { font-weight: 400; display: flex; gap: .5rem; align-items: flex-start; }
label.check input { width: auto; margin-top: .35rem; }
#account, #account-again { overflow-wrap: anywhere; }
[hidden] { display: none; }
`;

export const SCRIPT = `'use strict';
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var token = location.hash.slice(1);
  history.replaceState(null, '', location.pathname);
  var csrf = '';
  var spend = false;
  var SECTIONS = ['choose', 'lnbits', 'nwc', 'code', 'done'];

  function show(name) {
    SECTIONS.forEach(function (s) { $(s).hidden = s !== name; });
    $('cancel').hidden = name === 'done' || !name;
  }
  function say(text) { $('status').textContent = text; }
  function fail(text) { $('error').textContent = text; $('error').hidden = !text; }
  function post(path, body) {
    return fetch('/c/' + path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify(body || {}),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.message || 'Something went wrong. Please try again.');
        return data;
      });
    });
  }
  function busy(form, value) {
    form.querySelector('button').disabled = value;
  }

  function start(data) {
    csrf = data.csrf;
    $('account').textContent = data.account;
    $('account-again').textContent = data.account;
    say('');
    var kinds = $('kinds');
    data.kinds.forEach(function (kind) {
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = kind.label;
      button.addEventListener('click', function () {
        fail('');
        if (kind.id === 'nwc') {
          spend = kind.spend === true;
          $('nwc-spend').hidden = !spend;
          $('nwc-receive').hidden = spend;
          $('ack-row').hidden = !spend;
          $('ack').required = spend;
        }
        show(kind.id);
      });
      kinds.appendChild(button);
    });
    show('choose');
  }

  $('lnbits-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var form = event.target;
    fail('');
    busy(form, true);
    say('Checking the wallet…');
    post('lnbits', { url: $('url').value, invoiceKey: $('key').value, label: $('label').value })
      .then(function (data) {
        $('key').value = '';
        $('target').textContent = data.name;
        say('');
        show('code');
      })
      .catch(function (error) { say(''); fail(error.message); })
      .finally(function () { busy(form, false); });
  });

  $('nwc-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var form = event.target;
    fail('');
    busy(form, true);
    say('Checking the wallet…');
    post('nwc', { connection: $('connection').value, label: $('nwc-label').value, spend: spend, acknowledged: spend && $('ack').checked })
      .then(function (data) {
        $('connection').value = '';
        $('target').textContent = data.name;
        var list = $('permissions');
        list.textContent = '';
        (data.permissions || []).forEach(function (text) {
          var item = document.createElement('li');
          item.textContent = text;
          list.appendChild(item);
        });
        $('granted').hidden = !(data.permissions || []).length;
        $('limit').textContent = data.limit || '';
        $('limit').hidden = !data.limit;
        say('');
        show('code');
      })
      .catch(function (error) { say(''); fail(error.message); })
      .finally(function () { busy(form, false); });
  });

  $('code-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var form = event.target;
    fail('');
    busy(form, true);
    post('code', { code: $('confirm').value })
      .then(function () { say(''); show('done'); })
      .catch(function (error) { fail(error.message); })
      .finally(function () { busy(form, false); });
  });

  $('cancel').addEventListener('click', function () {
    post('cancel').finally(function () {
      show('');
      $('key').value = '';
      $('connection').value = '';
      fail('');
      say('Cancelled. Nothing was connected. You can close this page.');
    });
  });

  if (!token) { say(''); fail('This page needs the link from your chat with the bot. Send /connect there to get one.'); return; }
  post('session', { token }).then(start).catch(function (error) { say(''); fail(error.message); });
})();
`;
