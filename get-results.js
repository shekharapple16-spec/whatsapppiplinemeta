import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = "shekharapple16-spec/hclplaywrightaspire";
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const toPhone = "whatsapp:+918506806998";

async function getLatestRunResults() {
  try {
    // Get latest workflow run
    const runsUrl = `https://api.github.com/repos/${GITHUB_REPO}/actions/runs?per_page=1`;
    const runsRes = await axios.get(runsUrl, {
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    const run = runsRes.data.workflow_runs[0];
    console.log("🔍 Latest run:", run.id, "Status:", run.status, "Conclusion:", run.conclusion);

    if (run.status !== "completed") {
      console.log("⏳ Workflow not completed yet");
      return;
    }

    let testStats = {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
    };

    // Get jobs to extract test results from logs
    const jobsUrl = `https://api.github.com/repos/${GITHUB_REPO}/actions/runs/${run.id}/jobs`;
    const jobsRes = await axios.get(jobsUrl, {
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    console.log("📋 Jobs found:", jobsRes.data.jobs.length);

    // Look for test result patterns in job output
    for (const job of jobsRes.data.jobs) {
      console.log("Job:", job.name, "Conclusion:", job.conclusion);
      
      // Try to get job logs
      if (job.logs_url) {
        try {
          const logsRes = await axios.get(job.logs_url, {
            headers: {
              Authorization: `token ${GITHUB_TOKEN}`,
            },
            responseType: "text",
          });

          const logs = logsRes.data;
          
          // Extract test counts from logs
          const passedMatch = logs.match(/(\d+)\s+(?:passed|✓)/i);
          const failedMatch = logs.match(/(\d+)\s+(?:failed|✗|×)/i);
          const skippedMatch = logs.match(/(\d+)\s+(?:skipped|⊝)/i);
          const totalMatch = logs.match(/(\d+)\s+(?:total|tests? run)/i);

          if (passedMatch) testStats.passed = parseInt(passedMatch[1]);
          if (failedMatch) testStats.failed = parseInt(failedMatch[1]);
          if (skippedMatch) testStats.skipped = parseInt(skippedMatch[1]);
          if (totalMatch) testStats.total = parseInt(totalMatch[1]);

          console.log("Test Stats from logs:", testStats);
        } catch (e) {
          console.log("Could not fetch logs");
        }
      }
    }

    // Calculate total if not set
    if (!testStats.total) {
      testStats.total = testStats.passed + testStats.failed + testStats.skipped;
    }

    // Build simple message with only test counts
    const message = `✅ Passed: ${testStats.passed}
❌ Failed: ${testStats.failed}
⊝ Skipped: ${testStats.skipped}
📈 Total: ${testStats.total}`;

    await sendWhatsAppMessage(message);
    console.log("✅ Results sent to WhatsApp");

  } catch (error) {
    console.error("❌ Error:", error.response?.data || error.message);
  }
}

async function sendWhatsAppMessage(message) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  
  let fromNumber = TWILIO_PHONE_NUMBER;
  if (!fromNumber.startsWith("whatsapp:")) {
    fromNumber = `whatsapp:${fromNumber}`;
  }

  const data = new URLSearchParams();
  data.append("From", fromNumber);
  data.append("To", toPhone);
  data.append("Body", message);

  try {
    const response = await axios.post(url, data, {
      auth: {
        username: TWILIO_ACCOUNT_SID,
        password: TWILIO_AUTH_TOKEN,
      },
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    
    console.log("💬 WhatsApp message sent:", response.data.sid);
  } catch (error) {
    console.error("Twilio Error:", error.response?.data || error.message);
  }
}

await getLatestRunResults();
