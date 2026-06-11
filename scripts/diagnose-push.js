/* Push notification pipeline diagnostic.
 * 1. Counts registered push tokens in the production DB
 * 2. Sends one test push to the owner's own account
 * 3. Fetches the Expo delivery receipt to surface the exact FCM error, if any
 */
require('dotenv').config();
// Windows resolvers often refuse SRV lookups that mongodb+srv needs
require('node:dns').setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');

const OWNER_EMAIL = process.argv[2] || 'gautam4698@gmail.com';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const users = mongoose.connection.collection('users');

  const total = await users.countDocuments({ role: { $in: ['student', 'teacher', 'admin'] } });
  const withToken = await users.countDocuments({ pushToken: { $exists: true, $nin: ['', null] } });
  console.log(`Users: ${total}, with pushToken: ${withToken}`);

  const recent = await users
    .find(
      { pushToken: { $exists: true, $nin: ['', null] } },
      { projection: { email: 1, role: 1, pushToken: 1, updatedAt: 1 } },
    )
    .sort({ updatedAt: -1 })
    .limit(5)
    .toArray();
  console.log('Most recently updated token holders:');
  recent.forEach((u) =>
    console.log(`  ${u.role} ${u.email} token=${String(u.pushToken).slice(0, 28)}... updatedAt=${u.updatedAt}`),
  );

  const me = await users.findOne(
    { email: OWNER_EMAIL },
    { projection: { email: 1, role: 1, pushToken: 1 } },
  );
  if (!me) {
    console.log(`\nOwner account ${OWNER_EMAIL} not found — skipping live push test.`);
  } else if (!me.pushToken) {
    console.log(`\nOwner account ${OWNER_EMAIL} (${me.role}) has NO pushToken — token registration side is failing.`);
  } else {
    console.log(`\nOwner account ${OWNER_EMAIL} (${me.role}) token: ${me.pushToken.slice(0, 28)}...`);
    console.log('Sending test push...');
    const sendRes = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: me.pushToken,
        title: 'Push diagnostic',
        body: 'Testing notification pipeline — you can ignore this.',
        sound: 'default',
        priority: 'high',
        channelId: 'default',
      }),
    });
    const sendJson = await sendRes.json();
    console.log('Ticket response:', JSON.stringify(sendJson, null, 2));

    const ticketId = sendJson?.data?.id;
    if (ticketId) {
      console.log('Waiting 12s for delivery receipt...');
      await sleep(12000);
      const rcptRes = await fetch('https://exp.host/--/api/v2/push/getReceipts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [ticketId] }),
      });
      const rcptJson = await rcptRes.json();
      console.log('Receipt:', JSON.stringify(rcptJson, null, 2));
    }
  }

  await mongoose.disconnect();
})().catch((e) => {
  console.error('Diagnostic failed:', e);
  process.exit(1);
});
