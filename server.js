const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");
const { Expo } = require("expo-server-sdk");
const cron = require("node-cron");
const mongoose = require("mongoose");

const app = express();

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json()); 

const expo = new Expo();

// --- MONGODB SETUP ---
const MONGO_URI = "mongodb+srv://adepusanjay812_db_user:abcd123@cluster0.w0ntbpk.mongodb.net/tkrcet_app?retryWrites=true&w=majority";

mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected Successfully"))
  .catch((err) => console.error("❌ MongoDB Connection Error:", err));

// Define User Schema
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  expoPushToken: { type: String, default: null } // Stored to send notifications
});

const User = mongoose.model("User", userSchema);

// --- SCRAPING FUNCTION ---
async function getStudentData(username, password) {
  const loginResponse = await axios.post(
    "http://103.171.190.44/TKRCET/index.php",
    new URLSearchParams({ username, password, login: "Login" }),
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      maxRedirects: 0,
      validateStatus: () => true,
    }
  );

  const cookie = loginResponse.headers["set-cookie"]?.[0];
  if (!cookie) throw new Error("Login Failed. Please check your credentials.");

  const pageResponse = await axios.get(
    "http://103.171.190.44/TKRCET/StudentInformationForStudent.php",
    { headers: { Cookie: cookie } }
  );

  const html = pageResponse.data;
  const $ = cheerio.load(html);

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
      let rowPresentCount = 0;
      let rowAbsentCount = 0;
      let rowTotalPeriods = 0;

      $(cols).slice(2).each((j, td) => {
        const cellText = $(td).text().replace(/\s+/g, ' ').trim();
        const colSpan = parseInt($(td).attr('colspan') || '1', 10);
        let status = null;
        let subject = null;

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

  let presentSubjects = [];
  let absentSubjects = [];
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

// --- BACKGROUND CRON JOB LOGIC ---
async function runAttendanceAlerts() {
  console.log(`\n⏰ Running Scheduled Attendance Checks... (${new Date().toLocaleTimeString()})`);

  try {
    // Only fetch users who have an active push token
    const users = await User.find({ expoPushToken: { $ne: null } });

    for (const user of users) {
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
        console.log(`✅ Alert sent to ${user.username}`);

        // ⚠️ Wait 2 seconds before next student to prevent college server bans
        await new Promise(resolve => setTimeout(resolve, 2000)); 

      } catch (error) {
        console.error(`❌ Failed background check for ${user.username}:`, error.message);
      }
    }
  } catch (dbError) {
    console.error("Database error during cron job:", dbError);
  }
}

cron.schedule("40 12 * * *", () => runAttendanceAlerts(), { timezone: "Asia/Kolkata" });
cron.schedule("0 16 * * *", () => runAttendanceAlerts(), { timezone: "Asia/Kolkata" });

// --- ROUTES ---

// Login / Fetch Attendance
app.post("/attendance", async (req, res) => {
  try {
    const { username, password, expoPushToken } = req.body;
    
    // Attempt scraping first to verify credentials
    const data = await getStudentData(username, password);

    // If successful, save/update user in MongoDB
    let updateData = { password };
    if (expoPushToken && Expo.isExpoPushToken(expoPushToken)) {
      updateData.expoPushToken = expoPushToken;
    }

    await User.findOneAndUpdate(
      { username },
      { $set: updateData },
      { upsert: true, new: true } // Upsert creates if it doesn't exist
    );

    console.log(`💾 User ${username} logged in & saved to DB.`);
    res.json({ success: true, data });

  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Logout (Removes Push Token so they stop getting notifications)
app.post("/logout", async (req, res) => {
  try {
    const { username } = req.body;
    await User.findOneAndUpdate(
      { username },
      { $set: { expoPushToken: null } }
    );
    console.log(`🚪 User ${username} logged out. Push token removed.`);
    res.json({ success: true, message: "Logged out successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: "Logout failed" });
  }
});

app.get("/", (req, res) => {
  res.status(200).json({ success: true, message: "TKRCET Backend is Running on MongoDB!" });
});

if (process.env.NODE_ENV !== 'production') {
  app.listen(3000, () => {
    console.log("🚀 Server running on port 3000");
  });
}



// --- MANUAL TEST ROUTE ---
app.get("/test-alerts", async (req, res) => {
  console.log("🛠️ Manual push notification test triggered!");
  
  // We trigger the function but don't await it so Postman doesn't timeout 
  // if you have many users in the database (since it waits 2 seconds per user).
  runAttendanceAlerts();

  res.json({ 
    success: true, 
    message: "Test alerts triggered in the background! Check your server console and your phone." 
  });
});






module.exports = app;
