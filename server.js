const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");
const { Expo } = require("expo-server-sdk");
const cron = require("node-cron"); // <-- NEW: Added for scheduling

const app = express();

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json()); 

// Initialize Expo SDK
const expo = new Expo();

// --- MOCK DATABASE (For Testing) ---
// In a real app, replace this with MongoDB or Firebase
// We use a Map so if the same user logs in again, it just updates their token
const usersDB = new Map();

async function getStudentData(username, password) {
  // 1. LOGIN
  const loginResponse = await axios.post(
    "http://103.171.190.44/TKRCET/index.php",
    new URLSearchParams({
      username,
      password,
      login: "Login",
    }),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      maxRedirects: 0,
      validateStatus: () => true,
    }
  );

  const cookie = loginResponse.headers["set-cookie"]?.[0];

  if (!cookie) {
    throw new Error("Login Failed");
  }

  // 2. FETCH STUDENT PAGE
  const pageResponse = await axios.get(
    "http://103.171.190.44/TKRCET/StudentInformationForStudent.php",
    {
      headers: {
        Cookie: cookie,
      },
    }
  );

  const html = pageResponse.data;
  const $ = cheerio.load(html);

  // 3. PROFILE & BASIC INFO PARSING
  const relativePhotoPath = $('img[alt="Student Photo"]').attr('src');
  const photoUrl = relativePhotoPath && !relativePhotoPath.includes('http') 
    ? `http://103.171.190.44/TKRCET/${relativePhotoPath}` 
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
    course: extractField('Course:'),
    section: extractField('Section:'),
    photoUrl: photoUrl || null
  };

  // 4. OVERALL ATTENDANCE
  const text = html.replace(/<[^>]*>/g, " ");
  const percentageMatch = text.match(/(\d+\.\d+)%/);
  const percentage = percentageMatch ? percentageMatch[1] + "%" : "";

  const attendanceMatch = text.match(/Attendance[\s\S]*?(\d+)\s+(\d+)\s+(\d+)\s+(\d+\.\d+)%/);
  const conducted = attendanceMatch?.[1] || "";
  const present = attendanceMatch?.[2] || "";
  const absent = attendanceMatch?.[3] || "";

  // 5. TODAY'S DETAILED PARSING
  const dateMatch = html.match(/Today's Attendance :: Date: (\d{2}-\d{2}-\d{4})/);
  const todayDate = dateMatch ? dateMatch[1] : null;

  let presentSubjects = []; // <-- NEW: Tracking present subjects
  let absentSubjects = [];
  let todayPresentCount = 0;
  let todayAbsentCount = 0;
  let totalScheduledPeriods = 0;
  let todayPeriodsList = []; 

  if (todayDate) {
    const dateTd = $('td').filter(function() {
      return $(this).text().trim() === todayDate;
    }).first();

    if (dateTd.length > 0) {
      const todayRow = dateTd.parent('tr');
      const periodCells = todayRow.find('td').slice(2); 

      periodCells.each((index, element) => {
        const cell = $(element);
        const cellText = cell.text().replace(/\s+/g, ' ').trim();
        const colSpan = parseInt(cell.attr('colspan') || '1', 10);

        let status = null;
        let subject = null;

        if (cellText.includes('Present')) {
          status = 'Present';
          todayPresentCount += colSpan;
        } else if (cellText.includes('Absent')) {
          status = 'Absent';
          todayAbsentCount += colSpan;
        }

        if (status) {
          totalScheduledPeriods += colSpan;
          const subjectMatch = cellText.match(/\((.*?)\)/);
          if (subjectMatch && subjectMatch[1]) {
            subject = subjectMatch[1].trim();

            if (status === 'Absent') absentSubjects.push(subject);
            if (status === 'Present') presentSubjects.push(subject);
          }

          todayPeriodsList.push({
            subject: subject || 'Unknown',
            status: status,
            colspan: colSpan 
          });
        }
      });
    }
  }

  return {
    profile, 
    overallAttendance: { conducted, present, absent, percentage },
    today: {
      date: todayDate,
      totalScheduledPeriods: totalScheduledPeriods || 6,
      periodsTaken: todayPresentCount + todayAbsentCount,
      presentSubjects: presentSubjects, // <-- Added here
      absentSubjects: absentSubjects,
      periodsList: todayPeriodsList 
    },
  };
}

// --- BACKGROUND CRON JOB LOGIC ---
async function runAttendanceAlerts() {
  console.log(`\n⏰ Running Scheduled Attendance Checks... (${new Date().toLocaleTimeString()})`);
  
  // Loop through everyone saved in our mock DB
  for (const [username, user] of usersDB.entries()) {
    try {
      if (!Expo.isExpoPushToken(user.expoPushToken)) continue;

      const data = await getStudentData(user.username, user.password);
      
      // Remove duplicate subject names (e.g., 2 periods of Math just shows "Math")
      const uniquePresent = [...new Set(data.today.presentSubjects)].join(", ") || "None";
      const uniqueAbsent = [...new Set(data.today.absentSubjects)].join(", ") || "None";
      const overall = data.overallAttendance.percentage;

      // Construct the clean notification body
      const notificationBody = `Overall: ${overall}\n✅ Present: ${uniquePresent}\n❌ Absent: ${uniqueAbsent}`;

      const messages = [{
        to: user.expoPushToken,
        sound: "default",
        title: "📊 Attendance Summary",
        body: notificationBody,
      }];

      await expo.sendPushNotificationsAsync(messages);
      console.log(`✅ Alert sent to ${username}`);

      // ⚠️ CRITICAL: Wait 2 seconds before checking the next student to prevent college server bans
      await new Promise(resolve => setTimeout(resolve, 2000)); 

    } catch (error) {
      console.error(`❌ Failed background check for ${username}:`, error.message);
    }
  }
}

// 🕒 SCHEDULE THE CRON JOBS (IST Timezone)
// Runs at 12:40 PM every day
cron.schedule("40 12 * * *", () => {
  runAttendanceAlerts();
}, { timezone: "Asia/Kolkata" });

// Runs at 4:00 PM every day
cron.schedule("0 16 * * *", () => {
  runAttendanceAlerts();
}, { timezone: "Asia/Kolkata" });


// --- ROUTES ---
app.post("/attendance", async (req, res) => {
  try {
    const { username, password, expoPushToken } = req.body;

    // Fetch data to ensure credentials work and to send back to the app UI
    const data = await getStudentData(username, password);

    // Save/Update user in our test DB if they provided a valid Expo token
    if (expoPushToken && Expo.isExpoPushToken(expoPushToken)) {
      usersDB.set(username, { username, password, expoPushToken });
      console.log(`💾 User ${username} registered for automated alerts.`);
    }

    // Notice: We don't send the push notification here anymore! 
    // It is exclusively handled by the Cron jobs now.

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get("/", (req, res) => {
  res.status(200).json({ 
    success: true,
    message: "TKRCET Automated Backend is Running!" 
  });
});

if (process.env.NODE_ENV !== 'production') {
  app.listen(3000, () => {
    console.log("🚀 Server running on port 3000 with Cron Jobs enabled");
  });
}

module.exports = app;
