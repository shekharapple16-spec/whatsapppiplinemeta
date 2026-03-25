# Server-Meta: WhatsApp QA Bot with GitHub Actions Integration

## 📋 Overview

**Server-Meta** is an intelligent QA bot that connects WhatsApp messaging with GitHub Actions test automation. It allows users to trigger and monitor Playwright tests directly from WhatsApp using natural language commands, powered by the Groq AI API.

---

## 🎯 What It Does

This application provides a conversational interface via WhatsApp where users can:
- **Request test runs** with simple messages like "run tests" or "execute tests"
- **Receive real-time test results** including pass/fail counts and failure details
- **Track test execution** as the bot polls GitHub Actions for completion
- **Access test reports** with direct links to GitHub Actions runs

---

## 🤔 Why It Exists

- **Simplified QA Workflow**: No need to manually trigger GitHub Actions workflows or check dashboards
- **Accessibility**: QA engineers and stakeholders can interact with test infrastructure via familiar WhatsApp interface
- **Automation**: AI agent automatically understands user intent and executes appropriate commands
- **Real-time Notifications**: Immediate feedback on test execution status and results

---

## 🏗️ How It Works (Architecture)

```
WhatsApp Message
      ↓
Meta Webhook
      ↓
Express Server (server-meta.js)
      ↓
Groq AI Agent (understands intent)
      ↓
Tool Executor (runs GitHub Actions workflow)
      ↓
GitHub Actions API (triggers Playwright tests)
      ↓
Poll for Completion (checks run status)
      ↓
Parse Test Report (extracts results from artifacts)
      ↓
Send WhatsApp Response (back to user)
```

---

## 🔧 Components

### **1. Webhook Handler**
- `GET /webhook` - Verifies Meta's webhook subscription
- `POST /webhook` - Receives incoming WhatsApp messages

### **2. Agent Loop**
- Uses Groq AI to understand user commands
- Decides when to trigger the `run_tests` tool
- Maintains conversation history per user (phone number)

### **3. Tool Executor**
- `run_tests()` - The only available tool
- Triggers GitHub Actions workflow via API
- Polls GitHub until test completion
- Extracts and parses Playwright JSON report
- Returns summary to user

### **4. GitHub Integration**
- Dispatches GitHub Actions workflows
- Fetches workflow run status
- Downloads test artifacts (JSON reports)
- Parses Playwright test results

### **5. WhatsApp Integration**
- Sends messages via Meta's Graph API
- Acknowledges incoming messages
- Delivers final results to users

---

## 📦 What You Need (Environment Variables)

```env
# Meta WhatsApp
META_PHONE_ID=<your-meta-phone-id>
META_API_TOKEN=<your-meta-bearer-token>
WEBHOOK_VERIFY_TOKEN=<your-webhook-verify-token>

# GitHub
GITHUB_TOKEN=<your-github-personal-access-token>

# Groq AI
GROQ_API_KEY=<your-groq-api-key>

# Server
PORT=3000 (optional, defaults to 3000)
```

---

## 🚀 How to Set It Up

### **1. Prerequisites**
- Node.js 16+ installed
- Meta Business Account with WhatsApp Business API access
- GitHub repository with Playwright tests in GitHub Actions
- Groq API account

### **2. Installation**

```bash
# Clone or download the repository
cd ui-mcp

# Install dependencies
npm install

# Create .env file with all required credentials
echo "META_PHONE_ID=..." >> .env
echo "META_API_TOKEN=..." >> .env
echo "WEBHOOK_VERIFY_TOKEN=..." >> .env
echo "GITHUB_TOKEN=..." >> .env
echo "GROQ_API_KEY=..." >> .env
echo "PORT=3000" >> .env
```

### **3. Configure Repos**

Edit the `REPOS` array in `server-meta.js` to add your repositories:

```javascript
const REPOS = [
  {
    id: 1,
    name: "Your Project Name",
    keywords: ["your", "keywords"],
    repo: "owner/repo-name",
    workflow: "workflow-file-id",
    branch: "main",
  },
];
```

**How to find workflow ID:**
```bash
curl -H "Authorization: token YOUR_GITHUB_TOKEN" \
  https://api.github.com/repos/OWNER/REPO/actions/workflows
```

### **4. Start the Server**

```bash
node server-meta.js
```

Expected output:
```
✅ Server running on port 3000
```

### **5. Configure Meta Webhook**

In Meta Business Suite, set:
- **Callback URL**: `https://your-domain.com/webhook`
- **Verify Token**: (same as `WEBHOOK_VERIFY_TOKEN` in .env)
- **Subscribe to messages** and **message_template_status_update** webhooks

---

## 💬 How to Use

### **User Side (WhatsApp)**

Simply send a message to your WhatsApp Business number:

```
User: "run tests"
Bot:  "⚙️ Ok mere Aakaa..."
Bot:  "⏳ [0m] queued"
Bot:  "⏳ [1m] in_progress"
Bot:  "Tests done ✅5 passed ❌0 failed ⊝0 skipped ⏱120s
       All passing! 🎉
       Run: https://github.com/.../runs/123456"
```

### **Supported Commands**
- "run tests"
- "execute tests"
- "trigger tests"
- "run playwright tests"
- (Any variation that implies running tests)

---

## 📊 Data Flow

### **Message Parsing**
```
WhatsApp → Meta Webhook → Extract phone + message text
```

### **AI Intent Recognition**
```
Groq API with system prompt → Decides if "run_tests" tool should be called
```

### **GitHub Workflow Trigger**
```
POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches
```

### **Polling Loop**
```
Every 30 seconds: GET /repos/{owner}/{repo}/actions/runs/{run_id}
Until status = "completed"
```

### **Report Extraction**
```
Download artifact (json-report.zip)
→ Extract playwright-results.json
→ Walk test suites and specs
→ Count: passed, failed, skipped, duration
→ List failed test titles
```

---

## 📝 Key Files & Endpoints

| File/Endpoint | Purpose |
|---|---|
| `server-meta.js` | Main server file |
| `GET /health` | Health check endpoint |
| `GET /webhook` | Meta webhook verification |
| `POST /webhook` | Receives WhatsApp messages |
| `POST /groq-api` | (internal) Calls Groq for AI |
| `POST /github-api` | (internal) Calls GitHub API |

---

## 🔐 Security Considerations

1. **Environment Variables**: Never commit `.env` file
2. **GitHub Token**: Use fine-grained personal access tokens with repo-specific permissions
3. **Webhook Verification**: Always verify `WEBHOOK_VERIFY_TOKEN` matches
4. **Rate Limiting**: Groq (tier-dependent) and GitHub (60/hour unauthenticated, 5000/hour authenticated)

---

## 🛠️ Troubleshooting

| Issue | Solution |
|---|---|
| **Webhook not receiving messages** | Check Meta webhook settings match callback URL and verify token |
| **"Unknown tool" error** | Only `run_tests` tool is implemented; other commands won't trigger it |
| **Tests not completing** | Increase polling timeout or check GitHub Actions status page |
| **Report not found** | Ensure artifact is named `json-report` in your GitHub Actions workflow |
| **Groq rate limit** | Wait 15 seconds and retry (auto-handled) |

---

## 📚 Technologies Used

- **Express.js** - Web server framework
- **axios** - HTTP client for API calls
- **dotenv** - Environment variable management
- **Groq API** - AI agent for intent recognition
- **GitHub API** - Workflow automation and artifact access
- **Meta WhatsApp API** - Messaging delivery
- **jszip** - Artifact ZIP extraction

---

## 📄 License & Attribution

Built for automated QA testing via WhatsApp. Customize as needed.

---

## 🤝 Contributing

To extend functionality:
1. Add new repos to `REPOS` array
2. Define additional tools in `TOOL_DEFINITIONS`
3. Implement tool logic in `executeTool()` function
4. Update system prompt in `runAgent()` for new behaviors

---

---

## 🔬 Function-by-Function Explanation

### **1. `executeTool(name, args, phone)`**

**Purpose**: Executes the `run_tests` tool when Groq AI requests it.

**Step-by-Step Flow**:
1. Find the repository based on `args.repo_id` (defaults to repo ID 1)
2. Log the tool call and arguments to console
3. If tool name is not `run_tests`, return error message
4. **Trigger GitHub Actions workflow**:
   - POST to GitHub API with workflow ID and branch
   - This starts the test run
5. **Wait 12 seconds** for the workflow to appear in GitHub's run list
6. **Fetch latest run**: GET the most recent workflow run
7. **Poll until completion**:
   - Wait 30 seconds
   - Check run status via GitHub API
   - If status is "completed", load the test report (step 8)
   - If still running, log progress and continue polling
8. **Load Report**: Call `loadReport()` to fetch and parse test results
9. **Format Response**:
   - Extract test counts (passed/failed/skipped/duration)
   - List failed test titles
   - Add link to GitHub Actions run
10. **Return formatted message** to send back via WhatsApp

**Parameters**:
- `name` - Tool function name (only "run_tests" is valid)
- `args` - Object with optional `repo_id` property
- `phone` - User's phone number for storing results

**Returns**: String message with test results or error

**Error Handling**: Catches API errors and returns user-friendly error message

---

### **2. `runAgent(phone, userMessage)`**

**Purpose**: Main AI agent loop that understands user intent and decides which tool to call.

**Step-by-Step Flow**:
1. **Get conversation history** for this phone number (max 10 exchanges stored)
2. **Build message array**:
   - System prompt (tells AI it's a QA bot and how to behave)
   - Past conversation history
   - Current user message
3. **Loop up to 10 times** (tool call iterations):
   - **Call Groq API** with messages and tool definitions
   - Groq returns: either assistant response or tool call request
   - If **no tool calls**: AI is done, break loop
   - If **tool calls present**: Execute each tool (usually just "run_tests")
   - Add tool results back to message array for context
4. **Extract final response** from Groq's assistant message
5. **Save conversation history**:
   - Add user message and assistant response to history
   - Keep only last 20 messages (10 exchanges) per phone number
6. **Return final response** to send to WhatsApp

**Parameters**:
- `phone` - User's phone number (used as conversation key)
- `userMessage` - Text message from user

**Returns**: String with AI response to send back to user

**Key Behaviors**:
- Groq model: `openai/gpt-oss-120b` (open-source equivalent of GPT-4)
- Temperature: 0.1 (very deterministic, focused)
- Max tokens: 512 (keep responses brief)

---

### **3. `app.get("/webhook", ...)`**

**Purpose**: Validates Meta's webhook during initial setup.

**Step-by-Step Flow**:
1. Extract query parameters: `hub.mode`, `hub.verify_token`, `hub.challenge`
2. Check if `mode === "subscribe"` AND `token === WEBHOOK_VERIFY_TOKEN`
3. If valid: Send `challenge` string back (Meta's verification requirement)
4. If invalid: Send 403 (Forbidden) response

**Meta Setup**: When you set up the webhook in Meta Business Suite, it sends this request to verify ownership of the callback URL.

---

### **4. `app.post("/webhook", ...)`**

**Purpose**: Receives incoming WhatsApp messages from Meta.

**Step-by-Step Flow**:
1. **Parse incoming webhook body** from Meta
2. **Verify message exists**:
   - Check `body.entry[0].changes[0].value.messages[0]`
   - Extract: `fromPhone` (sender's phone number) and `messageBody` (text)
3. If no message body, send 200 OK and return
4. **Log the message** to console
5. **Immediately send 200 OK** to Meta (acknowledge receipt)
6. **Send quick acknowledgment** to user: "⚙️ Ok mere Aakaa..."
7. **Run agent asynchronously** (in background):
   - Call `runAgent(fromPhone, messageBody)`
   - Send the response back to user via WhatsApp
   - Catch and log any errors

**Why async?**: Don't wait for agent to finish before responding to Meta. This prevents webhook timeout.

---

### **5. `app.get("/health", ...)`**

**Purpose**: Simple health check endpoint for monitoring.

**Step-by-Step Flow**:
1. Respond with plain text "ok"

**Use Case**: External monitors or load balancers can ping this to check if server is running.

---

### **6. `ghHeaders()`**

**Purpose**: Helper function to create GitHub API headers.

**Step-by-Step Flow**:
1. Create object with two headers:
   - `Authorization: token {GITHUB_TOKEN}` (authentication)
   - `X-GitHub-Api-Version: 2022-11-28` (API version)
2. Return headers object

**Used By**: `ghGet()`, GitHub API calls

---

### **7. `ghGet(path)`**

**Purpose**: Reusable GitHub API GET request helper.

**Step-by-Step Flow**:
1. Make axios GET request to `https://api.github.com{path}`
2. Include GitHub headers via `ghHeaders()`
3. Return response data

**Example Usage**: `ghGet("/repos/owner/repo/actions/runs/12345")`

---

### **8. `loadReport(phone, repo, runId, run)`**

**Purpose**: Download and parse Playwright test results from GitHub artifacts.

**Step-by-Step Flow**:
1. **Fetch artifacts list** from GitHub for this workflow run
2. **Find "json-report" artifact** in the list
   - If not found: Save empty report and return
3. **Download artifact ZIP file** from GitHub:
   - Download from artifacts API endpoint
   - Use `arraybuffer` response type (binary data)
   - Follow redirects (Max 5)
4. **Extract ZIP file**:
   - Use JSZip library to parse ZIP content
   - Find `playwright-results.json` file inside
5. **Parse JSON**: Convert file content to JavaScript object
6. **Extract summary** by calling `extractSummary()`
7. **Store in memory**: Save to `lastReports[phone]` with:
   - Repository info
   - Run URL
   - Conclusion (success/failure)
   - Test summary object
8. **Log results** to console

**Error Handling**: Catches all errors and logs them (doesn't crash)

---

### **9. `extractSummary(report)`**

**Purpose**: Walk through Playwright JSON report and count test results.

**Step-by-Step Flow**:
1. **Initialize counters**: `passed`, `failed`, `skipped`, `total`, `duration`
2. **Create arrays**: `failedTests`, `passedTests`, `skippedTests`
3. **Define recursive `walk()` function**:
   - For each spec in suite:
     - For each test in spec:
       - Check test status (passed/failed/skipped)
       - Add to appropriate count and array
       - Add test duration to total duration
   - Recursively walk child suites
4. **Start walking** from root suites in report
5. **Calculate totals**:
   - `total = passed + failed + skipped`
   - Convert duration from milliseconds to seconds
6. **Return summary object** with all counts and test details

**Test Status Mapping**:
- Passed: "passed" or "expected" → increment `s.passed`
- Failed: "failed" or "unexpected" → increment `s.failed`
- Skipped: "skipped" or "pending" → increment `s.skipped`

---

### **10. `send(toPhone, message)`**

**Purpose**: Send a text message via WhatsApp to a user.

**Step-by-Step Flow**:
1. **Prepare payload**:
   - `messaging_product: "whatsapp"`
   - `to: toPhone` (recipient phone number)
   - `type: "text"`
   - `text: { body: message }` (message content)
2. **POST to Meta Graph API**:
   - Endpoint: `https://graph.facebook.com/v18.0/{META_PHONE_ID}/messages`
   - Include Meta API Bearer token in Authorization header
3. **If successful**: Message sent
4. **If error**: Log error details to console (don't crash)

**Note**: Errors are logged but not thrown (fire-and-forget pattern)

---

### **11. `sleep(ms)`**

**Purpose**: Pause execution for a specified number of milliseconds.

**Step-by-Step Flow**:
1. Return a new Promise
2. Use `setTimeout` to resolve after `ms` milliseconds
3. Used with `await` keyword: `await sleep(5000)` waits 5 seconds

**Used By**: 
- Delay between workflow trigger and run list fetch (12 seconds)
- Delay between status polls (30 seconds)
- Delay after rate limiting (15 seconds)

---

## 📊 Function Call Sequence (Complete User Flow)

```
1. User sends WhatsApp message → Meta Webhook
                ↓
2. app.post("/webhook") receives message
                ↓
3. Extract phone + messageBody
                ↓
4. Send 200 OK to Meta
                ↓
5. Send "⚙️ Ok mere Aakaa..." to user
                ↓
6. runAgent(phone, messageBody) starts (async)
                ↓
7. Call Groq API with system prompt + message history
                ↓
8. Groq decides to call run_tests tool
                ↓
9. executeTool("run_tests", {repo_id: 1}, phone)
                ↓
10. Trigger GitHub Actions workflow via POST
                ↓
11. Wait 12 seconds
                ↓
12. Fetch workflow runs list via ghGet()
                ↓
13. Poll every 30 seconds: ghGet(/repos/.../runs/{runId})
                ↓
14. When status = "completed":
    - loadReport() downloads artifact
    - extractSummary() parses test results
    - Return formatted message to Groq
                ↓
15. Groq formats final response
                ↓
16. send(phone, response) sends result via WhatsApp
                ↓
17. Save chat history in chatHistory[phone]
```

---

**Last Updated**: March 2026  
**Maintained By**: QA Team
