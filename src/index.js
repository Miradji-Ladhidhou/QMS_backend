import 'dotenv/config';
import app from './app.js';
import { scheduleNotificationJob } from './jobs/notificationJob.js';

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`QMS SaaS backend listening on port ${PORT}`);
});

scheduleNotificationJob();
