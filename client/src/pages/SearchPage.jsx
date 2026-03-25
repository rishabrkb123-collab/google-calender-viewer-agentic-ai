import React, { useContext, useEffect, useState } from 'react';
import { UiContext } from '../App.jsx';
import Card from '../components/ui/Card.jsx';
import Button from '../components/ui/Button.jsx';

export default function SearchPage() {
  const { searchQuery, setSearchQuery, refreshTick } = useContext(UiContext);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      const resp = await fetch('/api/events?maxResults=100');
      const data = await resp.json().catch(() => null);
      setEvents(Array.isArray(data?.events) ? data.events : []);
      setLoading(false);
    };
    load();
  }, [refreshTick]);

  const filtered = events.filter((event) => {
    const text = `${event.summary} ${event.location} ${event.description}`.toLowerCase();
    return text.includes(searchQuery.toLowerCase());
  });

  return (
    <div className="page">
      <div className="section-head">
        <div>
          <h3>Search</h3>
          <p>Find events quickly across your calendar data.</p>
        </div>
        <Button variant="ghost" onClick={() => setSearchQuery('')}>Clear</Button>
      </div>

      <Card className="filter-panel">
        <label className="field">
          Keyword
          <input
            className="input"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Title, location, organizer"
          />
        </label>
      </Card>

      {loading ? (
        <div className="skeleton-grid">
          <div className="skeleton-card"></div>
          <div className="skeleton-card"></div>
          <div className="skeleton-card"></div>
        </div>
      ) : (
        <div className="events">
          {filtered.map((event) => (
            <Card className="event-card" key={event.id}>
              <h4 className="truncate" title={event.summary || ''}>
                {event.summary || '(No title)'}
              </h4>
              <p className="muted truncate">{event.location || 'No location'}</p>
              <a className="btn ghost" href={event.htmlLink} target="_blank" rel="noreferrer">
                View
              </a>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
