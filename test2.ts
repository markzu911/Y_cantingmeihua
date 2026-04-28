import axios from "axios";

async function testHost(host: string) {
  const url = `https://${host}/api/tool/launch`;
  try {
    const res = await axios.post(url, { userId: "test", toolId: "test" }, { timeout: 5000 });
    console.log(`[SUCCESS] ${url} - Status: ${res.status}`);
  } catch (e: any) {
    if (e.response && e.response.status !== 404) {
      console.log(`[SUCCESS_WITH_ERROR] ${url} - Status: ${e.response.status}`);
    } else {
      console.log(`[FAILED] ${url} - ${e.message}`);
    }
  }
}

async function run() {
  await testHost("api.aibigtree.com");
  await testHost("tools.aibigtree.com");
  await testHost("aibigtree.com");
  await testHost("www.aibigtree.com");
}

run();
