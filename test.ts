import axios from "axios";

async function test() {
  try {
    console.log("Testing https://aibigtree.com/api/tool/launch");
    await axios.post("https://aibigtree.com/api/tool/launch", { userId: "test", toolId: "test" }, { timeout: 5000 });
    console.log("Success aibigtree");
  } catch (e: any) {
    console.error("aibigtree:", e.message);
  }

  try {
    console.log("Testing http://aibigtree.com/api/tool/launch");
    await axios.post("http://aibigtree.com/api/tool/launch", { userId: "test", toolId: "test" }, { timeout: 5000 });
    console.log("Success http aibigtree");
  } catch (e: any) {
    console.error("http aibigtree:", e.message);
  }

  try {
    console.log("Testing https://tools.aibigtree.com/api/tool/launch");
    await axios.post("https://tools.aibigtree.com/api/tool/launch", { userId: "test", toolId: "test" }, { timeout: 5000 });
    console.log("Success tools.aibigtree");
  } catch (e: any) {
    console.error("tools.aibigtree:", e.message);
  }
}

test();
