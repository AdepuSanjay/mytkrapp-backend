const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");
const { Expo } = require("expo-server-sdk");
const cron = require("node-cron");

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

  // 3. PROFILE & BASIC INFO PARSING (Contact Details Omitted)
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
    fatherName: extractField('Father Name:'),
    course: extractField('Course:'),
    year: extractField('Year:'),
    section: extractField('Section:'),
    photoUrl: photoUrl || null
    // Intentionally skipped Student/Father/Mother Mobile numbers
  };

  // 4. OVERALL ATTENDANCE
  const text = html.replace(/<[^>]*>/g, " ");
  const percentageMatch = text.match(/(\d+\.\d+)%/);
  const percentage = percentageMatch ? percentageMatch[1] + "%" : "";

  const attendanceMatch = text.match(/Attendance[\s\S]*?(\d+)\s+(\d+)\s+(\d+)\s+(\d+\.\d+)%/);
  const conducted = attendanceMatch?.[1] || "";
  const present = attendanceMatch?.[2] || "";
  const absent = attendanceMatch?.[3] || "";

  // 5. ACADEMIC PROMOTION HISTORY
  const academicHistory = [];
  $('th:contains("Academic Year")').closest('table').find('tbody tr').each((i, el) => {
    const cols = $(el).find('td');
    if(cols.length >= 7) {
      // Strips out the mentor's phone number using regex
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

  // 6. WEEKLY CLASS TIMETABLE
  const weeklyTimetable = [];
  $('h5:contains("Student Present Class Time Table")').parent().next('table').find('tbody tr').each((i, el) => {
    const cols = $(el).find('td');
    const day = $(cols[0]).text().trim();
    if(day && day !== '--' && day !== 'Staff Details') {
      const schedule = [];
      $(cols).slice(1).each((j, td) => {
        const subject = $(td).text().trim();
        const colSpan = parseInt($(td).attr('colspan') || '1', 10);
        if(subject) {
          schedule.push({ subject, periods: colSpan });
        }
      });
      if(schedule.length > 0) {
        weeklyTimetable.push({ day, schedule });
      }
    }
  });

  // 7. FULL DAY-WISE ATTENDANCE HISTORY (All Days)
  const fullDaywiseAttendance = [];
  let todayDetails = null; // We will extract today out of the full list
  
  $('p:contains("Daywise Detailed Attendance")').closest('.container-fluid').find('table tbody tr').each((i, el) => {
    const cols = $(el).find('td');
    const dateText = $(cols[0]).text().trim();
    const weekDay = $(cols[1]).text().trim();
    
    // Ensure it's a valid date row (DD-MM-YYYY)
    if (dateText.match(/\d{2}-\d{2}-\d{4}/)) {
      const periods = [];
      let rowPresentCount = 0;
      let rowAbsentCount = 0;
      let rowTotalPeriods = 0;

      $(cols).slice(2).each((j, td) => {
        const cellText = $(td).text().replace(/\s+/g, ' ').trim();
        const colSpan = parseInt($(td).attr('colspan') || '1', 10);
        
        let status = null;
        let subject = null;

        if (cellText.includes('Present')) {
          status = 'Present';
          rowPresentCount += colSpan;
        } else if (cellText.includes('Absent')) {
          status = 'Absent';
          rowAbsentCount += colSpan;
        }

        if (status) {
          rowTotalPeriods += colSpan;
          const subjectMatch = cellText.match(/\((.*?)\)/);
          if (subjectMatch && subjectMatch[1]) {
            subject = subjectMatch[1].trim();
          }

          periods.push({
            subject: subject || 'Unknown',
            status: status,
            colSpan: colSpan
          });
        }
      });

      const dayRecord = {
        date: dateText,
        weekDay: weekDay,
        totalPeriods: rowTotalPeriods,
        presentCount: rowPresentCount,
        absentCount: rowAbsentCount,
        periods: periods
      };

      fullDaywiseAttendance.push(dayRecord);
      
      // If this is the most recent (first) row, treat it as "Today" or latest
      if (i === 0) {
        todayDetails = dayRecord;
      }
    }
  });

  // Isolate subjects for notifications based on the latest recorded day
  let presentSubjects = [];
  let absentSubjects = [];
  if (todayDetails) {
      todayDetails.periods.forEach(p => {
          if (p.status === 'Present') presentSubjects.push(p.subject);
          if (p.status === 'Absent') absentSubjects.push(p.subject);
      });
  }

  return {
    profile, 
    overallAttendance: { conducted, present, absent, percentage },
    academicHistory,
    weeklyTimetable,
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

// --- BACKGROUND CRON JOB LOGIC ---
async function runAttendanceAlerts() {
  console.log(`\n⏰ Running Scheduled Attendance Checks... (${new Date().toLocaleTimeString()})`);

  for (const [username, user] of usersDB.entries()) {
    try {
      if (!Expo.isExpoPushToken(user.expoPushToken)) continue;

      const data = await getStudentData(user.username, user.password);

      const uniquePresent = data.latestDay.presentSubjects.join(", ") || "None";
      const uniqueAbsent = data.latestDay.absentSubjects.join(", ") || "None";
      const overall = data.overallAttendance.percentage;

      const notificationBody = `Overall: ${overall}\n✅ Present: ${uniquePresent}\n❌ Absent: ${uniqueAbsent}`;

      const messages = [{
        to: user.expoPushToken,
        sound: "default",
        title: `📊 Attendance Update (${data.latestDay.date})`,
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
cron.schedule("40 12 * * *", () => {
  runAttendanceAlerts();
}, { timezone: "Asia/Kolkata" });

cron.schedule("0 16 * * *", () => {
  runAttendanceAlerts();
}, { timezone: "Asia/Kolkata" });

// --- ROUTES ---
app.post("/attendance", async (req, res) => {
  try {
    const { username, password, expoPushToken } = req.body;

    const data = await getStudentData(username, password);

    if (expoPushToken && Expo.isExpoPushToken(expoPushToken)) {
      usersDB.set(username, { username, password, expoPushToken });
      console.log(`💾 User ${username} registered for automated alerts.`);
    }

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

// --- MANUAL TEST ROUTE ---
app.get("/test-alerts", async (req, res) => {
  console.log("🛠️ Manual push notification test triggered!");

  if (usersDB.size === 0) {
    return res.json({ 
      success: false, 
      message: "No users in database. You need to log in on the app first!" 
    });
  }

  await runAttendanceAlerts();

  res.json({ 
    success: true, 
    message: "Test alerts triggered successfully! Check your server console and your phone." 
  });
});

module.exports = app;
