require('dotenv').config({ path: require('path').join(__dirname, '../.env.local') });

async function main() {
  const route = process.argv[2];

  if (!route || !route.startsWith('/api/cron/')) {
    console.error('Usage: node scripts/invoke-cron.js /api/cron/<job>');
    process.exit(1);
  }

  const baseUrl = process.env.CRON_BASE_URL || process.env.NEXT_PUBLIC_APP_URL;
  const secret = process.env.CRON_SECRET;

  if (!baseUrl) {
    console.error('CRON_BASE_URL or NEXT_PUBLIC_APP_URL is required');
    process.exit(1);
  }

  if (!secret) {
    console.error('CRON_SECRET is required');
    process.exit(1);
  }

  const url = new URL(route, baseUrl);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${secret}` },
  });

  const text = await response.text();
  let body = text;
  try {
    body = JSON.stringify(JSON.parse(text), null, 2);
  } catch {}

  console.log(body);

  if (!response.ok) {
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
