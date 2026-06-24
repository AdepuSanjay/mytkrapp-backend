const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const { Expo } = require("expo-server-sdk");

const app = express();
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

  // 3. BASIC INFO PARSING
  const text = html.replace(/<[^>]*>/g, " ");
  const rollNo = text.match(/Roll No:\s*([A-Z0-9]+)/i)?.[1] || "";
  const name = text.match(/Name:\s*([A-Za-z ]+)/)?.[1]?.trim() || "";
  const percentageMatch = text.match(/(\d+\.\d+)%/);
  const percentage = percentageMatch ? percentageMatch[1] + "%" : "";

  // 4. OVERALL ATTENDANCE
  const attendanceMatch = text.match(
    /Attendance[\s\S]*?(\d+)\s+(\d+)\s+(\d+)\s+(\d+\.\d+)%/
  );
  const conducted = attendanceMatch?.[1] || "";
  const present = attendanceMatch?.[2] || "";
  const absent = attendanceMatch?.[3] || "";

  // 5. TODAY'S DETAILED ABSENCE PARSING (Corrected with Cheerio)
  const dateMatch = html.match(/Today's Attendance :: Date: (\d{2}-\d{2}-\d{4})/);
  const todayDate = dateMatch ? dateMatch[1] : null;

  let absentSubjects = [];
  let todayPresentCount = 0;
  let todayAbsentCount = 0;

  if (todayDate) {
    // Find the specific table cell (td) that EXACTLY matches today's date
    const dateTd = $('td').filter(function() {
      return $(this).text().trim() === todayDate;
    }).first();

    if (dateTd.length > 0) {
      // Get the parent row (tr) of this date cell in the Daywise table
      const todayRow = dateTd.parent('tr');

      // The first 2 cells are Date and Weekday. The periods start from index 2.
      const periodCells = todayRow.find('td').slice(2);

      periodCells.each((index, element) => {
        // Get the text inside the cell, clean up extra spaces (e.g., "Present (EDA)")
        const cellText = $(element).text().replace(/\s+/g, ' ').trim();

        if (cellText.includes('Present')) {
          todayPresentCount++;
        } else if (cellText.includes('Absent')) {
          todayAbsentCount++;

          // Extract the subject name sitting inside the parenthesis
          const subjectMatch = cellText.match(/\((.*?)\)/);
          if (subjectMatch && subjectMatch[1]) {
            absentSubjects.push(subjectMatch[1].trim());
          }
        }
      });
    }
  }

  return {
    rollNo,
    name,
    overallAttendance: {
      conducted,
      present,
      absent,
      percentage,
    },
    today: {
      date: todayDate,
      presentPeriods: todayPresentCount,
      absentPeriods: todayAbsentCount,
      absentSubjects: absentSubjects, // e.g., ["ESD", "CC"]
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

app.listen(3000, () => {
  console.log("Server running on port 3000");
});
