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
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;

// GitHub credentials
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = "shekharapple16-spec/hclplaywrightaspire";
const GITHUB_WORKFLOW = "207958236";

// ✅ FIX 1: Separate GET route for Meta webhook verification
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("🔍 Webhook verification attempt:");
  console.log("  mode:", mode);
  console.log("  token:", token);
  console.log("  expected:", WEBHOOK_VERIFY_TOKEN);

  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
    console.log("✅ Webhook verified successfully!");
    res.status(200).send(challenge);
  } else {
    console.log("❌ Webhook verification failed - token mismatch");
    res.sendStatus(403);
  }
});

// ✅ POST route to receive WhatsApp messages
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    if (body.object) {
      if (
        body.entry &&
        body.entry[0].changes &&
        body.entry[0].changes[0].value.messages
      ) {
        const fromPhone =
          body.entry[0].changes[0].value.messages[0].from;
        const messageBody =
          body.entry[0].changes[0].value.messages[0].text?.body;

        if (!messageBody) {
          return res.sendStatus(200);
        }

        console.log("📱 Message received:", messageBody);
        console.log("From:", fromPhone);

        // Send immediate acknowledgment to Meta
        res.sendStatus(200);

        // Check if message is "run test"
        if (messageBody.toLowerCase().trim() === "run test") {
          console.log("🚀 Triggering GitHub Actions workflow...");

          await sendWhatsAppMessage(
            fromPhone,
            "✅ Test workflow triggered! Running Playwright tests...\n⏳ Checking results in background..."
          );

          // Trigger GitHub Actions
          await triggerGitHubWorkflow();

          // Check status in background (don't await)
          checkWorkflowStatus(fromPhone);
        } else {
          await sendWhatsAppMessage(
            fromPhone,
            `You said: "${messageBody}"\n\nSend *run test* to trigger Playwright tests 🚀`
          );
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

// ✅ Trigger GitHub workflow
async function triggerGitHubWorkflow() {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${GITHUB_WORKFLOW}/dispatches`;

  console.log("🔗 Triggering GitHub workflow:", url);

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
    console.error(
      "❌ GitHub error:",
      error.response?.data || error.message
    );
    throw error;
  }
}

// ✅ FIX 2: Correct Meta API URL (graph.facebook.com not graph.instagram.com)
async function sendWhatsAppMessage(toPhone, message) {
  const url = `https://graph.facebook.com/v18.0/${META_PHONE_ID}/messages`;

  console.log("📤 Sending WhatsApp message to:", toPhone);

  try {
    const response = await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        to: toPhone,
        type: "text",
        text: { body: message },
      },
      {
        headers: {
          Authorization: `Bearer ${META_API_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
    console.log("💬 Message sent:", response.data.messages[0].id);
  } catch (error) {
    console.error(
      "❌ Meta API error:",
      error.response?.data || error.message
    );
    throw error;
  }
}

// ✅ Check workflow status and send results back to WhatsApp
async function checkWorkflowStatus(toPhone) {
  try {
    console.log("🔄 Checking workflow status...");

    // Wait for workflow to start
    await new Promise((resolve) => setTimeout(resolve, 5000));

    const url = `https://api.github.com/repos/${GITHUB_REPO}/actions/runs?per_page=1`;

    let maxAttempts = 24; // Check for up to 4 minutes
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
        console.log(
          `⏳ Attempt (${attempt + 1}/${maxAttempts}): status=${run.status} conclusion=${run.conclusion || "N/A"}`
        );

        if (run.status === "completed") {
          // Get jobs to extract test results
          const jobsUrl = `https://api.github.com/repos/${GITHUB_REPO}/actions/runs/${run.id}/jobs`;
          const jobsRes = await axios.get(jobsUrl, {
            headers: {
              Authorization: `token ${GITHUB_TOKEN}`,
              "X-GitHub-Api-Version": "2022-11-28",
            },
          });

          let testStats = { passed: 0, failed: 0, skipped: 0 };

          for (const job of jobsRes.data.jobs) {
            try {
              const logsUrl = `https://api.github.com/repos/${GITHUB_REPO}/actions/jobs/${job.id}/logs`;
              const logsRes = await axios.get(logsUrl, {
                headers: { Authorization: `token ${GITHUB_TOKEN}` },
              });

              const logs = logsRes.data;
              const passedMatch = logs.match(/(\d+)\s+passed/);
              const failedMatch = logs.match(/(\d+)\s+failed/);
              const skippedMatch = logs.match(/(\d+)\s+skipped/);

              if (passedMatch) testStats.passed = parseInt(passedMatch[1]);
              if (failedMatch) testStats.failed = parseInt(failedMatch[1]);
              if (skippedMatch) testStats.skipped = parseInt(skippedMatch[1]);

              if (
                testStats.passed > 0 ||
                testStats.failed > 0 ||
                testStats.skipped > 0
              ) {
                break;
              }
            } catch (e) {
              console.log("Could not fetch logs for job:", e.message);
            }
          }

          const total =
            testStats.passed + testStats.failed + testStats.skipped;
          const statusEmoji =
            run.conclusion === "success" ? "🟢" : "🔴";

          const resultMessage =
            `${statusEmoji} *Test Results*\n\n` +
            `✅ Passed:  ${testStats.passed}\n` +
            `❌ Failed:  ${testStats.failed}\n` +
            `⊝ Skipped: ${testStats.skipped}\n` +
            `📈 Total:   ${total}\n\n` +
            `🔗 Details: ${run.html_url}`;

          await sendWhatsAppMessage(toPhone, resultMessage);
          console.log("✅ Results sent to WhatsApp!");
          return;
        }
      } catch (innerError) {
        console.error("Error checking status:", innerError.message);
      }

      attempt++;
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 10000));
      }
    }

    // Timeout after 4 minutes
    await sendWhatsAppMessage(
      toPhone,
      `⏱️ Tests still running after 4 mins\n\n🔗 Check here: https://github.com/${GITHUB_REPO}/actions`
    );
  } catch (error) {
    console.error("❌ Error in checkWorkflowStatus:", error.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));