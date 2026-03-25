const { MongoClient } = require('mongodb');
const dotenv = require('dotenv');

dotenv.config();

const {
  MONGODB_URI,
  MONGODB_DB_NAME,
} = process.env;

async function checkEvents() {
  if (!MONGODB_URI) {
    console.error('Missing MONGODB_URI in .env');
    process.exit(1);
  }

  const mongoClient = new MongoClient(MONGODB_URI);

  try {
    await mongoClient.connect();

    // Resolve database name
    let resolvedMongoDbName;
    const envDb = String(MONGODB_DB_NAME || '').trim();
    if (envDb) {
      resolvedMongoDbName = envDb;
    } else {
      try {
        const parsed = new URL(MONGODB_URI);
        const fromPath = parsed.pathname.replace(/^\//, '').trim();
        resolvedMongoDbName = fromPath || 'test';
      } catch {
        resolvedMongoDbName = 'test';
      }
    }

    const db = mongoClient.db(resolvedMongoDbName);
    const calendarEventsCollection = db.collection('calendar_events');

    console.log('Connected to MongoDB database:', resolvedMongoDbName);
    console.log('Using collection: calendar_events');

    // Get all events
    const allEvents = await calendarEventsCollection.find({}).toArray();
    console.log(`Total events in database: ${allEvents.length}`);

    // Get events without deleted filter
    const activeEvents = await calendarEventsCollection.find({
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }]
    }).toArray();
    console.log(`Active events (not deleted): ${activeEvents.length}`);

    // Display event summaries
    console.log('\nEvent details:');
    allEvents.forEach((event, index) => {
      console.log(`${index + 1}. ${event.summary || '(No title)'} - ${event.start || 'No start time'}`);
      if (event.deletedAt) {
        console.log(`   (Deleted: ${event.deletedAt})`);
      }
    });

    // Check for user profiles
    try {
      const userProfilesCollection = db.collection('user_profiles');
      const profiles = await userProfilesCollection.find({}).toArray();
      console.log(`\nUser profiles: ${profiles.length}`);
      profiles.forEach(profile => {
        console.log(`  Email: ${profile.email}, Name: ${profile.name || 'N/A'}`);
      });
    } catch (e) {
      console.log('No user_profiles collection or error accessing it:', e.message);
    }

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await mongoClient.close();
  }
}

checkEvents();