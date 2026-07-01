const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");
const { Expo } = require("expo-server-sdk");
const mongoose = require("mongoose");
const { CookieJar } = require("tough-cookie");
// 🚨 REMOVED: require("axios-cookiejar-support") from here!

const app = express();

// ==========================================
// SERVER CONFIGURATION
// ==========================================
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json()); 

const expo = new Expo();
const ASPNET_BASE_URL = "https://www.tkrcetautonomous.org";
const PHP_BASE_URL = "http://103.171.190.44/TKRCET";

// ==========================================
// MONGODB DATABASE SETUP
// ==========================================
const MONGO_URI = "mongodb+srv://adepusanjay812_db_user:abcd123@cluster0.w0ntbpk.mongodb.net/tkrcet_app?retryWrites=true&w=majority";
let isConnected = false;

async function connectDB() {
  if (isConnected) return;
  try {
    const db = await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
    });
    isConnected = db.connections[0].readyState;
    console.log("✅ MongoDB Connected (Serverless)");
  } catch (err) {
    console.error("❌ MongoDB Connection Error:", err);
    throw err;
  }
}

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  expoPushToken: { type: String, default: null } 
});

const User = mongoose.model("User", userSchema);

// ==========================================
// MODULE 1: ATTENDANCE SCRAPER (PHP PORTAL)
// ==========================================
async function getAttendanceData(username, password) {
  const loginResponse = await axios.post(
    `${PHP_BASE_URL}/index.php`,
    new URLSearchParams({ username, password, login: "Login" }),
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      maxRedirects: 0,
      validateStatus: () => true,
    }
  );

  const cookie = loginResponse.headers["set-cookie"]?.[0];
  if (!cookie) throw new Error("Attendance Login Failed. Please check your credentials.");

  const pageResponse = await axios.get(
    `${PHP_BASE_URL}/StudentInformationForStudent.php`,
    { headers: { Cookie: cookie } }
  );

  const html = pageResponse.data;
  const $ = cheerio.load(html);

  const relativePhotoPath = $('img[alt="Student Photo"]').attr('src');
  const photoUrl = relativePhotoPath && !relativePhotoPath.includes('http') 
    ? `${PHP_BASE_URL}/${relativePhotoPath}` 
    : relativePhotoPath;

  const extractField = (label) => {
    let val = "";
    $('strong').each((i, el) => {
      if ($(el).text().trim() === label) {
        val = $(el).parent().text().replace(label, '').replace(/&nbsp;/g, '').trim();
      }
    });
    return val;
  };

  const profile = {
    name: extractField('Name:'),
    rollNo: extractField('Roll No:'),
    fatherName: extractField('Father Name:'),
    course: extractField('Course:'),
    year: extractField('Year:'),
    section: extractField('Section:'),
    photoUrl: photoUrl || null
  };

  const text = html.replace(/<[^>]*>/g, " ");
  const percentageMatch = text.match(/(\d+\.\d+)%/);
  const percentage = percentageMatch ? percentageMatch[1] + "%" : "";

  const attendanceMatch = text.match(/Attendance[\s\S]*?(\d+)\s+(\d+)\s+(\d+)\s+(\d+\.\d+)%/);
  const conducted = attendanceMatch?.[1] || "";
  const present = attendanceMatch?.[2] || "";
  const absent = attendanceMatch?.[3] || "";

  const academicHistory = [];
  $('th:contains("Academic Year")').closest('table').find('tbody tr').each((i, el) => {
    const cols = $(el).find('td');
    if(cols.length >= 7) {
      const rawMentor = $(cols[6]).text().trim();
      const cleanMentor = rawMentor.replace(/\s*-\s*\d{10}/g, '').trim(); 
      academicHistory.push({
        sNo: $(cols[0]).text().trim(),
        academicYear: $(cols[1]).text().trim(),
        year: $(cols[2]).text().trim(),
        semester: $(cols[3]).text().trim(),
        section: $(cols[4]).text().trim(),
        status: $(cols[5]).text().trim(),
        mentor: cleanMentor
      });
    }
  });

  const weeklyTimetable = [];
  $('h5:contains("Student Present Class Time Table")').parent().next('table').find('tbody tr').each((i, el) => {
    const cols = $(el).find('td');
    const day = $(cols[0]).text().trim();
    if(day && day !== '--' && day !== 'Staff Details') {
      const schedule = [];
      $(cols).slice(1).each((j, td) => {
        const subject = $(td).text().trim();
        const colSpan = parseInt($(td).attr('colspan') || '1', 10);
        if(subject) schedule.push({ subject, periods: colSpan });
      });
      if(schedule.length > 0) weeklyTimetable.push({ day, schedule });
    }
  });

  const fullDaywiseAttendance = [];
  let todayDetails = null; 

  $('p:contains("Daywise Detailed Attendance")').closest('.container-fluid').find('table tbody tr').each((i, el) => {
    const cols = $(el).find('td');
    const dateText = $(cols[0]).text().trim();
    const weekDay = $(cols[1]).text().trim();

    if (dateText.match(/\d{2}-\d{2}-\d{4}/)) {
      const periods = [];
      let rowPresentCount = 0, rowAbsentCount = 0, rowTotalPeriods = 0;

      $(cols).slice(2).each((j, td) => {
        const cellText = $(td).text().replace(/\s+/g, ' ').trim();
        const colSpan = parseInt($(td).attr('colspan') || '1', 10);
        let status = null, subject = null;

        if (cellText.includes('Present')) { status = 'Present'; rowPresentCount += colSpan; }
        else if (cellText.includes('Absent')) { status = 'Absent'; rowAbsentCount += colSpan; }

        if (status) {
          rowTotalPeriods += colSpan;
          const subjectMatch = cellText.match(/\((.*?)\)/);
          if (subjectMatch && subjectMatch[1]) subject = subjectMatch[1].trim();
          periods.push({ subject: subject || 'Unknown', status: status, colSpan: colSpan });
        }
      });

      const dayRecord = {
        date: dateText, weekDay, totalPeriods: rowTotalPeriods,
        presentCount: rowPresentCount, absentCount: rowAbsentCount, periods
      };

      fullDaywiseAttendance.push(dayRecord);
      if (i === 0) todayDetails = dayRecord;
    }
  });

  let presentSubjects = [], absentSubjects = [];
  if (todayDetails) {
      todayDetails.periods.forEach(p => {
          if (p.status === 'Present') presentSubjects.push(p.subject);
          if (p.status === 'Absent') absentSubjects.push(p.subject);
      });
  }

  return {
    profile, overallAttendance: { conducted, present, absent, percentage },
    academicHistory, weeklyTimetable,
    latestDay: {
      date: todayDetails?.date || null,
      totalScheduledPeriods: todayDetails?.totalPeriods || 0,
      presentSubjects: [...new Set(presentSubjects)], 
      absentSubjects: [...new Set(absentSubjects)],
      periodsList: todayDetails?.periods || []
    },
    historicalAttendance: fullDaywiseAttendance 
  };
}


// ==========================================
// MODULE 2: MARKS & DASHBOARD (ASP.NET PORTAL)
// ==========================================
const normalizeString = (str) => {
    if (!str) return '';
    return str.replace(/[\s\u00A0\t\n\r]+/g, ' ').trim().toUpperCase();
};

function parsePortalDashboard(html) {
    const $ = cheerio.load(html);
    let photoSrc = $("#ctl00_ImgStudent").attr("src");
    
    if (photoSrc) photoSrc = photoSrc.replace(/&amp;/g, '&');
    
    const absolutePhotoUrl = photoSrc 
        ? new URL(photoSrc, `${ASPNET_BASE_URL}/StudentLogin/MainStud.aspx`).href 
        : null;

    const studentDetails = {
        name: $("#ctl00_lblStudName").text().trim(),
        htNo: $("#ctl00_lblHTNo").text().trim(),
        branch: $("#ctl00_lblBranch").text().trim(),
        semester: $("#ctl00_lblSem").text().trim(),
        photoUrl: absolutePhotoUrl 
    };

    const notifications = [];
    $("#ctl00_cpStudCorner_grdNotif tr").each((index, element) => {
        if (index === 0) return; 
        const tds = $(element).find("td");
        if (tds.length === 3) {
            notifications.push({
                date: $(tds[0]).text().trim(),
                notificationNo: $(tds[1]).text().trim(),
                message: $(tds[2]).text().trim()
            });
        }
    });

    return { studentDetails, notifications };
}

function parseOverallMarksData(html) {
    const $ = cheerio.load(html);
    
    const summary = {
        cgpa: $("#ctl00_cpStudCorner_lblFinalCGPA").text().split(":").pop().trim() || null,
        creditsObtained: $("#ctl00_cpStudCorner_lblCreditsObtained").text().split(":").pop().trim() || null,
        dueSubjects: $("#ctl00_cpStudCorner_lblDueSubjects").text().split(":").pop().trim() || null
    };

    const marks = [];
    let targetTable = null;
    $("table").each((i, el) => {
        const text = $(el).text();
        if (text.includes("Subject") && text.includes("Credits") && text.includes("Grade")) {
            targetTable = $(el);
        }
    });

    if (!targetTable) return { summary, marks }; 

    let headers = [];
    targetTable.find("tr").first().find("th, td").each((i, el) => {
        headers.push($(el).text().replace(/[\n\r\t]+/g, ' ').trim());
    });

    targetTable.find("tr").each((index, element) => {
        if (index === 0) return; 
        const rowData = {};
        let isEmptyRow = true;

        $(element).find("td").each((i, el) => {
            const key = headers[i] || `column_${i}`;
            const val = $(el).text().replace(/[\n\r\t]+/g, ' ').trim();
            rowData[key] = val;
            if (val !== "" && key !== "SlNo") isEmptyRow = false;
        });

        if (!isEmptyRow && Object.keys(rowData).length > 1) {
            marks.push({
                id: rowData["SlNo"],
                examCode: rowData["Exam Code"],
                subject: rowData["Subject ( No of Attempts )"],
                monthYear: rowData["Month & Year"],
                grade: rowData["FinalGrade"],
                credits: rowData["Credits"],
                status: rowData["Status"]
            });
        }
    });

    return { summary, marks };
}

function parseInternalMarksData(html) {
    const $ = cheerio.load(html);
    const marks = [];
    
    let targetTable = null;
    $("table").each((i, el) => {
        const text = $(el).text();
        if (text.includes("Exam Code") && text.includes("Subject Name")) targetTable = $(el);
    });

    if (!targetTable) return marks;

    let headers = [];
    targetTable.find("tr").first().find("th, td").each((i, el) => {
        headers.push($(el).text().replace(/[\n\r\t]+/g, ' ').trim());
    });

    targetTable.find("tr").each((index, element) => {
        if (index === 0) return; 
        
        const rowData = {};
        let isEmptyRow = true;

        $(element).find("td").each((i, el) => {
            const key = headers[i] || `column_${i}`;
            const val = $(el).text().replace(/[\n\r\t]+/g, ' ').trim();
            rowData[key] = val;
            if (val !== "" && key !== "SlNo") isEmptyRow = false;
        });

        if (!isEmptyRow && Object.keys(rowData).length > 1) marks.push(rowData); 
    });

    return marks;
}

// 🚨 THE FIX: Dynamic Import used here instead of require()
async function getAuthenticatedClient(username, password) {
    const { wrapper } = await import("axios-cookiejar-support"); // Dynamic ESM Import
    const jar = new CookieJar();
    const client = wrapper(axios.create({
        jar,
        withCredentials: true,
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/139 Safari/537.36" }
    }));

    const page1 = await client.get(`${ASPNET_BASE_URL}/Login.aspx`);
    let $ = cheerio.load(page1.data);

    const body1 = new URLSearchParams();
    body1.append("__EVENTTARGET", "lnkStudent");
    body1.append("__EVENTARGUMENT", "");
    body1.append("__VIEWSTATE", $("#__VIEWSTATE").val() || "");
    body1.append("__VIEWSTATEGENERATOR", $("#__VIEWSTATEGENERATOR").val() || "");
    body1.append("__EVENTVALIDATION", $("#__EVENTVALIDATION").val() || "");

    const page2 = await client.post(`${ASPNET_BASE_URL}/Login.aspx`, body1.toString(), {
        headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: `${ASPNET_BASE_URL}/Login.aspx`, Origin: ASPNET_BASE_URL }
    });

    $ = cheerio.load(page2.data);

    const body2 = new URLSearchParams();
    body2.append("__EVENTTARGET", "");
    body2.append("__EVENTARGUMENT", "");
    body2.append("__VIEWSTATE", $("#__VIEWSTATE").val() || "");
    body2.append("__VIEWSTATEGENERATOR", $("#__VIEWSTATEGENERATOR").val() || "");
    body2.append("__EVENTVALIDATION", $("#__EVENTVALIDATION").val() || "");
    body2.append("txtUserId", username);
    body2.append("txtPwd", password);
    body2.append("btnLogin", "Login");

    const loginResponse = await client.post(`${ASPNET_BASE_URL}/Login.aspx`, body2.toString(), {
        headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: `${ASPNET_BASE_URL}/Login.aspx`, Origin: ASPNET_BASE_URL },
        maxRedirects: 0,
        validateStatus: (status) => status >= 200 && status < 400
    });

    if (loginResponse.status === 302) {
        await client.get(`${ASPNET_BASE_URL}/StudentLogin/MainStud.aspx`);
        return client;
    }
    
    throw new Error("Portal Login failed. Check your credentials.");
}


// ==========================================
// MODULE 3: PUSH NOTIFICATIONS & CRON
// ==========================================
async function runAttendanceAlerts() {
  console.log(`\n⏰ Running Scheduled Attendance Checks... (${new Date().toLocaleTimeString()})`);
  try {
    const users = await User.find({ expoPushToken: { $ne: null } });
    for (const user of users) {
      try {
        if (!Expo.isExpoPushToken(user.expoPushToken)) continue;

        const data = await getAttendanceData(user.username, user.password);

        const uniquePresent = data.latestDay.presentSubjects.join(", ") || "None";
        const uniqueAbsent = data.latestDay.absentSubjects.join(", ") || "None";
        const overall = data.overallAttendance.percentage;

        const notificationBody = `Overall: ${overall}\n✅ Present: ${uniquePresent}\n❌ Absent: ${uniqueAbsent}`;

        const messages = [{
          to: user.expoPushToken,
          sound: "default",
          title: `📊 Attendance Update (${data.latestDay.date})`,
          body: notificationBody,
          priority: "high",
          channelId: "default"
        }];

        await expo.sendPushNotificationsAsync(messages);
        console.log(`✅ Alert sent to ${user.username}`);
        await new Promise(resolve => setTimeout(resolve, 2000)); 

      } catch (error) {
        console.error(`❌ Failed background check for ${user.username}:`, error.message);
      }
    }
  } catch (dbError) {
    console.error("Database error during cron job:", dbError);
  }
}


// ==========================================
// UNIFIED ROUTES
// ==========================================

// --- HEALTH & CRON ROUTES ---
app.get("/", async (req, res) => {
  try {
    await connectDB();
    res.status(200).json({ success: true, message: "Super TKRCET Backend is Running on MongoDB!" });
  } catch (err) {
    res.status(500).json({ success: false, message: "Database connection failed" });
  }
});

app.get("/api/cron-alerts", async (req, res) => {
  try {
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    await connectDB();
    await runAttendanceAlerts();
    res.json({ success: true, message: "Cron job executed successfully." });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/test-alerts", async (req, res) => {
  try {
    await connectDB();
    runAttendanceAlerts();
    res.json({ success: true, message: "Test alerts triggered in the background!" });
  } catch (err) {
    res.status(500).json({ success: false, message: "Test trigger failed" });
  }
});

app.post("/logout", async (req, res) => {
  try {
    await connectDB();
    await User.findOneAndUpdate({ username: req.body.username }, { $set: { expoPushToken: null } });
    res.json({ success: true, message: "Logged out successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: "Logout failed" });
  }
});

// --- ATTENDANCE PORTAL ROUTE ---
app.post("/attendance", async (req, res) => {
  try {
    await connectDB();
    const { username, password, expoPushToken } = req.body;
    const data = await getAttendanceData(username, password);

    let updateData = { password };
    if (expoPushToken && Expo.isExpoPushToken(expoPushToken)) updateData.expoPushToken = expoPushToken;

    await User.findOneAndUpdate({ username }, { $set: updateData }, { upsert: true, new: true });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- ASP.NET PORTAL ROUTES ---
app.post("/login", async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ success: false, error: "Missing credentials" });
        
        const client = await getAuthenticatedClient(username, password);
        const dashboardPage = await client.get(`${ASPNET_BASE_URL}/StudentLogin/MainStud.aspx`);
        const parsedData = parsePortalDashboard(dashboardPage.data);

        if (parsedData.studentDetails.photoUrl) {
            try {
                const imageResponse = await client.get(parsedData.studentDetails.photoUrl, {
                    responseType: 'arraybuffer',
                    headers: {
                        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
                        "Referer": `${ASPNET_BASE_URL}/StudentLogin/MainStud.aspx`
                    }
                });
                
                const contentType = imageResponse.headers['content-type'];
                if (contentType && contentType.includes('image')) {
                    const base64Image = Buffer.from(imageResponse.data, 'binary').toString('base64');
                    parsedData.studentDetails.photoUrl = `data:${contentType};base64,${base64Image}`;
                } else {
                    parsedData.studentDetails.photoUrl = null;
                }
            } catch (err) {
                parsedData.studentDetails.photoUrl = null;
            }
        }
        res.json({ success: true, data: parsedData });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/semesters", async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ success: false, error: "Missing credentials" });
        const client = await getAuthenticatedClient(username, password);
        const marksUrl = `${ASPNET_BASE_URL}/StudentLogin/Student/OverallMarksSemwise.aspx`;
        const page = await client.get(marksUrl, { headers: { Referer: `${ASPNET_BASE_URL}/StudentLogin/MainStud.aspx` } });
        const $ = cheerio.load(page.data);
        
        const semesters = [];
        $("input[type='submit'], input[type='button']").each((i, el) => {
            const val = $(el).val();
            if (val && $(el).attr("name").includes("btn") && val.trim().length > 3) semesters.push(val.trim());
        });
        res.json({ success: true, data: semesters });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/marks", async (req, res) => {
    try {
        const { username, password, semester } = req.body;
        if (!username || !password || !semester) return res.status(400).json({ success: false, error: "Missing credentials or semester" });

        const client = await getAuthenticatedClient(username, password);
        const marksUrl = `${ASPNET_BASE_URL}/StudentLogin/Student/OverallMarksSemwise.aspx`;
        const page = await client.get(marksUrl, { headers: { Referer: `${ASPNET_BASE_URL}/StudentLogin/MainStud.aspx` } });
        let $ = cheerio.load(page.data);

        const body = new URLSearchParams();
        $("input[type='hidden']").each((i, el) => body.append($(el).attr("name"), $(el).val() || ""));
        body.set("__EVENTTARGET", ""); 
        body.set("__EVENTARGUMENT", "");

        let foundBtnName = null, foundBtnVal = null;
        const targetFuzzy = normalizeString(semester).replace(/[^a-zA-Z0-9]/g, "");

        $("input[type='submit'], input[type='button']").each((i, el) => {
            const val = $(el).val();
            if (val && $(el).attr("name").includes("btn") && normalizeString(val).replace(/[^a-zA-Z0-9]/g, "") === targetFuzzy) {
                foundBtnName = $(el).attr("name");
                foundBtnVal = val; 
            }
        });

        if (!foundBtnName) return res.status(404).json({ success: false, error: `Semester '${semester}' not found.` });

        body.append(foundBtnName, foundBtnVal);
        const marksPost = await client.post(marksUrl, body.toString(), { headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: marksUrl, Origin: ASPNET_BASE_URL }});
        res.json({ success: true, semester_requested: semester, data: parseOverallMarksData(marksPost.data) });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/internal-semesters", async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ success: false, error: "Missing credentials" });

        const client = await getAuthenticatedClient(username, password);
        const internalUrl = `${ASPNET_BASE_URL}/StudentLogin/Student/InternalMarks.aspx`;

        const page = await client.get(internalUrl, { headers: { Referer: `${ASPNET_BASE_URL}/StudentLogin/MainStud.aspx` } });
        const $ = cheerio.load(page.data);
        
        const semesters = [];
        $("select option").each((i, el) => {
            const text = $(el).text().trim();
            if (text && text.includes("SEMESTER")) semesters.push(text);
        });

        res.json({ success: true, data: semesters });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/internal-marks", async (req, res) => {
    try {
        const { username, password, semester } = req.body;
        if (!username || !password || !semester) return res.status(400).json({ success: false, error: "Missing credentials or semester" });

        const client = await getAuthenticatedClient(username, password);
        const internalUrl = `${ASPNET_BASE_URL}/StudentLogin/Student/InternalMarks.aspx`;

        const pageGet = await client.get(internalUrl, { headers: { Referer: `${ASPNET_BASE_URL}/StudentLogin/MainStud.aspx` } });
        let $ = cheerio.load(pageGet.data);

        const body = new URLSearchParams();
        $("input[type='hidden']").each((i, el) => body.append($(el).attr("name"), $(el).val() || ""));

        let selectName = null, optionValue = null;
        const targetFuzzy = normalizeString(semester).replace(/[^a-zA-Z0-9]/g, "");

        $("select").each((i, selectEl) => {
            $(selectEl).find("option").each((j, optEl) => {
                if (normalizeString($(optEl).text()).replace(/[^a-zA-Z0-9]/g, "") === targetFuzzy) {
                    selectName = $(selectEl).attr("name"); 
                    optionValue = $(optEl).val(); 
                }
            });
        });

        if (!selectName || !optionValue) return res.status(404).json({ success: false, error: `Semester '${semester}' not found.` });

        body.set("__EVENTTARGET", selectName); 
        body.set("__EVENTARGUMENT", "");
        body.set(selectName, optionValue);

        const marksPost = await client.post(internalUrl, body.toString(), { 
            headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: internalUrl, Origin: ASPNET_BASE_URL }
        });

        res.json({ success: true, semester_requested: semester, data: parseInternalMarksData(marksPost.data) });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ==========================================
// START SERVER
// ==========================================
if (process.env.NODE_ENV !== 'production') {
  app.listen(3000, () => {
    console.log("🚀 Unified API Server running on port 3000");
  });
}

module.exports = app;
