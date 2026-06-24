const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const { Expo } = require("expo-server-sdk");

const app = express();

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json()); 

// Initialize Expo SDK
const expo = new Expo();

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

  // Load HTML into Cheerio for accurate DOM parsing
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
    fatherName: extractField('Father Name:'),
    course: extractField('Course:'),
    year: extractField('Year:'),
    section: extractField('Section:'),
    mobile: extractField('Student Mobile:'),
    photoUrl: photoUrl || null
  };

  // 4. OVERALL ATTENDANCE
  const text = html.replace(/<[^>]*>/g, " ");
  const percentageMatch = text.match(/(\d+\.\d+)%/);
  const percentage = percentageMatch ? percentageMatch[1] + "%" : "";
  
  const attendanceMatch = text.match(
    /Attendance[\s\S]*?(\d+)\s+(\d+)\s+(\d+)\s+(\d+\.\d+)%/
  );
  const conducted = attendanceMatch?.[1] || "";
  const present = attendanceMatch?.[2] || "";
  const absent = attendanceMatch?.[3] || "";

  // 5. TODAY'S DETAILED PARSING (Now includes specific periods list)
  const dateMatch = html.match(/Today's Attendance :: Date: (\d{2}-\d{2}-\d{4})/);
  const todayDate = dateMatch ? dateMatch[1] : null;

  let absentSubjects = [];
  let todayPresentCount = 0;
  let todayAbsentCount = 0;
  let totalScheduledPeriods = 0;
  let todayPeriodsList = []; // Array to hold individual period data for the frontend

  if (todayDate) {
    const dateTd = $('td').filter(function() {
      return $(this).text().trim() === todayDate;
    }).first();

    if (dateTd.length > 0) {
      const todayRow = dateTd.parent('tr');
      const periodCells = todayRow.find('td').slice(2); // Skip Date and Weekday

      periodCells.each((index, element) => {
        const cell = $(element);
        const cellText = cell.text().replace(/\s+/g, ' ').trim();
        const colSpan = parseInt(cell.attr('colspan') || '1', 10);

        let status = null;
        let subject = null;

        // Check if marked present or absent
        if (cellText.includes('Present')) {
          status = 'Present';
          todayPresentCount += colSpan;
        } else if (cellText.includes('Absent')) {
          status = 'Absent';
          todayAbsentCount += colSpan;
        }

        // If a status was found, extract subject and add to list
        if (status) {
          totalScheduledPeriods += colSpan;
          
          const subjectMatch = cellText.match(/\((.*?)\)/);
          if (subjectMatch && subjectMatch[1]) {
            subject = subjectMatch[1].trim();
            
            if (status === 'Absent') {
              absentSubjects.push(subject);
            }
          }

          // Push the detailed object for your frontend to map over
          todayPeriodsList.push({
            subject: subject || 'Unknown',
            status: status,
            colspan: colSpan // Lets frontend know if it's a 1-hour class or 3-hour lab
          });
        }
      });
    }
  }

  return {
    profile, 
    overallAttendance: {
      conducted,
      present,
      absent,
      percentage,
    },
    today: {
      date: todayDate,
      totalScheduledPeriods: totalScheduledPeriods || 6,
      periodsTaken: todayPresentCount + todayAbsentCount,
      presentPeriods: todayPresentCount,
      absentPeriods: todayAbsentCount,
      absentSubjects: absentSubjects,
      periodsList: todayPeriodsList // <--- NEW: Iterate over this in React Native!
    },
  };
}

app.post("/attendance", async (req, res) => {
  try {
    const { username, password, expoPushToken } = req.body;

    const data = await getStudentData(username, password);

    // --- PUSH NOTIFICATION LOGIC ---
    if (data.today.absentSubjects.length > 0 && expoPushToken) {
      if (Expo.isExpoPushToken(expoPushToken)) {
        const subjectsString = data.today.absentSubjects.join(", ");

        const messages = [{
          to: expoPushToken,
          sound: "default",
          title: "Attendance Alert ⚠️",
          body: `You were marked absent today for: ${subjectsString}.`,
          data: { absentSubjects: data.today.absentSubjects },
        }];

        try {
          const chunks = expo.chunkPushNotifications(messages);
          for (let chunk of chunks) {
            await expo.sendPushNotificationsAsync(chunk);
          }
          console.log(`Notification sent for absent periods: ${subjectsString}`);
        } catch (error) {
          console.error("Error sending push notification:", error);
        }
      } else {
        console.error(`Push token ${expoPushToken} is not a valid Expo push token`);
      }
    }

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

app.get("/", (req, res) => {
  res.status(200).json({ 
    success: true,
    message: "TKRCET Backend is running perfectly!" 
  });
});

if (process.env.NODE_ENV !== 'production') {
  app.listen(3000, () => {
    console.log("Server running on port 3000");
  });
}

module.exports = app;
