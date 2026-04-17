# Shadows of Brimstone — Mission Tracker

A web app for tracking missions across Shadows of Brimstone sourcebooks.

## Features

- **Mission management** — Add, edit, and delete missions organized by sourcebook
- **Tags & enemy types** — Categorize missions with tags (Preset Map, No Gates, etc.) and enemy types
- **Randomizer** — Pick a random incomplete mission, with filters for sourcebooks and tags
- **Completion history** — Track pass/fail results for completed missions
- **Import/Export** — Back up and restore your mission database as JSON

## Setup

```
npm install
npm start
```

The app runs at [http://localhost:3003](http://localhost:3003) by default. Set the `PORT` environment variable to change it.

## Data

Mission data is stored in a local SQLite database (`brimstone.db`), created automatically on first run.

### Export

```
node export.js
```

### Import

```
node import.js <export-file.json>
```
