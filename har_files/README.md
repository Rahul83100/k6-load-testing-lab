# 📂 HAR Recordings Directory

This folder is the dedicated workspace drop-zone for `.har` (HTTP Archive) files recorded from your browser.

---

## 🚀 How to Record a Clean HAR File (Chrome / Edge)

1. Open **Google Chrome** or **Microsoft Edge**.
2. Press `F12` (or `Ctrl + Shift + I`) to open **Developer Tools**.
3. Click on the **Network** tab.
4. **Crucial Setup**:
   - Check the **"Preserve log"** checkbox (so login redirects are not lost).
   - Check **"Disable cache"** (simulates realistic cold traffic).
   - Filter by **"Fetch/XHR"** (optional, recommended if you only want API calls and not images/fonts).
5. Perform the exact user actions on your website (e.g., Login ➔ Dashboard ➔ Attendance ➔ Hostel).
6. Once finished, click the **Export HAR** icon (an arrow pointing down over a line `↓` or right-click any request and choose **"Save all as HAR with content"**).
7. Save the `.har` file directly into this folder:
   ```
   har_files/<your_test_name>.har
   ```

---

## ⚡ Universal 1-Click Execution

You do **not** need to manually convert or edit any test scripts in the future. Just run:

```powershell
# Run by HAR filename or version keyword:
.\run_load_test.ps1 <har_name> -VUs <number_of_users>
```

**Examples:**
```powershell
.\run_load_test.ps1 prepespro2 -VUs 50
.\run_load_test.ps1 prepespro3 -VUs 100 -Duration "2m"
```

The runner will **automatically**:
1. Detect your `.har` file.
2. Auto-generate the k6 test script with all 50 account mappings and Grafana telemetry metrics.
3. Execute the load test.
4. Open the live Grafana dashboard at `http://127.0.0.1:5665` and download portal at `http://localhost:3001`.
