import dotenv from "dotenv";
import express from "express";
import axios from "axios";

dotenv.config();

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Meta WhatsApp credentials
const META_PHONE_ID = process.env.META_PHONE_ID;
const META_API_TOKEN = process.env.META_API_TOKEN;
const META_BUSINESS_ACCOUNT_ID = process.env.META_BUSINESS_ACCOUNT_ID;

// GitHub credentials
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = "shekharapple16-spec/hclplaywrightaspire";
const GITHUB_WORKFLOW = "207958236";

// Webhook endpoint to receive messages from Meta
app.post("/webhook", async (req, res) => {
  try {
    // Handle Meta webhook verification
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode && token) {
      if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN || token === "test_token") {
        console.log("✅ Webhook verified");
        res.status(200).send(challenge);
        return;
      } else {
        res.sendStatus(403);
        return;
      }
    }

    // Handle incoming messages
    const body = req.body;

    if (body.object) {
      if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
        const phoneNumberId = body.entry[0].changes[0].value.metadata.phone_number_id;
        const fromPhone = body.entry[0].changes[0].value.messages[0].from;
        const messageBody = body.entry[0].changes[0].value.messages[0].text.body;

        console.log("📱 Message received:", messageBody);
        console.log("From:", fromPhone);

        // Send immediate acknowledgment
        res.send("OK");

        // Check if message is "run test"
        if (messageBody.toLowerCase().trim() === "run test") {
          console.log("🚀 Triggering GitHub Actions workflow...");

          // Trigger GitHub Actions
          await triggerGitHubWorkflow();

          // Send response to WhatsApp
          await sendWhatsAppMessage(
            fromPhone,
            "✅ Test workflow triggered! Running Playwright tests...\n⏳ Checking results..."
          );

          // Check status in background (don't await)
          checkWorkflowStatus(fromPhone);
        } else {
          // Echo message back
          await sendWhatsAppMessage(fromPhone, `You said: "${messageBody}"\n\nTry: "run test" to trigger Playwright tests`);
        }
      } else {
        res.sendStatus(200);
      }
    } else {
      res.sendStatus(404);
    }
  } catch (error) {
    console.error("❌ Error:", error.message);
    res.sendStatus(500);
  }
});

// Trigger GitHub workflow
async function triggerGitHubWorkflow() {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${GITHUB_WORKFLOW}/dispatches`;

  console.log("🔗 GitHub URL:", url);

  try {
    const response = await axios.post(
      url,
      { ref: "master" },
      {
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );

    console.log("✅ Workflow triggered:", response.status);
  } catch (error) {
    console.error("🔗 GitHub error response:", error.response?.data || error.message);
    throw error;
  }
}

// Send WhatsApp message via Meta API
async function sendWhatsAppMessage(toPhone, message) {
  const url = `https://graph.instagram.com/v18.0/${META_PHONE_ID}/messages`;

  console.log("📤 Sending to:", toPhone);

  try {
    const data = {
      messaging_product: "whatsapp",
      to: toPhone,
      type: "text",
      text: {
        body: message,
      },
    };

    const response = await axios.post(url, data, {
      headers: {
        Authorization: `Bearer ${META_API_TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    console.log("💬 WhatsApp message sent:", response.data.messages[0].id);
  } catch (error) {
    console.error("📤 Meta API error:", error.response?.data || error.message);
    throw error;
  }
}

// Check workflow status and send results
async function checkWorkflowStatus(toPhone) {
  try {
    console.log("🔄 Starting workflow status check...");

    // Wait a bit for workflow to start
    await new Promise(resolve => setTimeout(resolve, 5000));

    const url = `https://api.github.com/repos/${GITHUB_REPO}/actions/runs?per_page=1`;

    let maxAttempts = 24; // Check for up to 4 minutes (24 * 10 seconds)
    let attempt = 0;

    while (attempt < maxAttempts) {
      try {
        const response = await axios.get(url, {
          headers: {
            Authorization: `token ${GITHUB_TOKEN}`,
            "X-GitHub-Api-Version": "2022-11-28",
          },
        });

        const run = response.data.workflow_runs[0];

        console.log(`⏳ Workflow status check (${attempt + 1}/${maxAttempts}):`, run.status, `- Conclusion: ${run.conclusion || 'N/A'}`);

        if (run.status === "completed") {
          // Get jobs to extract test results from logs
          const jobsUrl = `https://api.github.com/repos/${GITHUB_REPO}/actions/runs/${run.id}/jobs`;
          const jobsRes = await axios.get(jobsUrl, {
            headers: {
              Authorization: `token ${GITHUB_TOKEN}`,
              "X-GitHub-Api-Version": "2022-11-28",
            },
          });

          let testStats = { total: 0, passed: 0, failed: 0, skipped: 0 };

          // Extract test counts from job logs
          for (const job of jobsRes.data.jobs) {
            try {
              const logsUrl = `https://api.github.com/repos/${GITHUB_REPO}/actions/jobs/${job.id}/logs`;
              const logsRes = await axios.get(logsUrl, {
                headers: { Authorization: `token ${GITHUB_TOKEN}` },
              });

              const logs = logsRes.data;

              // Parse Playwright test output format
              const passedMatch = logs.match(/(\d+)\s+passed/);
              const failedMatch = logs.match(/(\d+)\s+failed/);
              const skippedMatch = logs.match(/(\d+)\s+skipped/);

              if (passedMatch) testStats.passed = parseInt(passedMatch[1]);
              if (failedMatch) testStats.failed = parseInt(failedMatch[1]);
              if (skippedMatch) testStats.skipped = parseInt(skippedMatch[1]);

              // If we found test results, break after first job with results
              if (testStats.passed > 0 || testStats.failed > 0 || testStats.skipped > 0) {
                break;
              }
            } catch (e) {
              console.log("Could not fetch logs for job:", e.message);
            }
          }

          // Calculate total
          testStats.total = testStats.passed + testStats.failed + testStats.skipped;

          // Build simple message with only test counts
          const resultMessage = `✅ Passed: ${testStats.passed}
❌ Failed: ${testStats.failed}
⊝ Skipped: ${testStats.skipped}
📈 Total: ${testStats.total}`;

          await sendWhatsAppMessage(toPhone, resultMessage);
          console.log("✅ Results sent to WhatsApp");
          return;
        }
      } catch (innerError) {
        console.error("Error checking status:", innerError.message);
      }

      attempt++;
      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10 seconds before next check
      }
    }

    // If still not completed after 4 minutes
    await sendWhatsAppMessage(
      toPhone,
      "⏱️ Tests are still running...\n\n🔗 Check progress: " + `https://github.com/${GITHUB_REPO}/actions`
    );
    console.log("⏱️ Workflow still running after 4 minutes");
  } catch (error) {
    console.error("❌ Error in checkWorkflowStatus:", error.message);
  }
}

const PORT = 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
