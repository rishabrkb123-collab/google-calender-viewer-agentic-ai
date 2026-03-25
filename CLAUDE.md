# Claude Code Guide for Google Calendar Viewer

## Project Overview
A full-stack Node.js application that integrates with Google Calendar API to provide a web-based calendar viewer with AI-powered chatbot capabilities.

## Tech Stack
- Node.js 18+
- Express.js 5.x
- React 18.x
- MongoDB Atlas
- Google Calendar API
- Ollama for AI inference

## Naming & Style
- Use functional components with hooks
- Prefer named exports over default exports
- Use 2-space indentation
- camelCase for variables and functions
- PascalCase for components and constructors
- UPPER_CASE for constants
- Descriptive variable names
- Comments for complex logic

## Commands
- Build client: `npm --prefix client run build`
- Run server: `npm start`
- Run server in watch mode: `npm run dev`
- Run client dev server: `npm --prefix client run dev`
- Test Ollama integration: `node test-ollama.js`
- Test chat functionality: `node test-chat.js`

## Development Notes
- The chatbot uses Ollama for natural language processing
- MongoDB is used for event storage and user data
- Google OAuth2 is used for authentication
- The frontend is a React SPA with a chat widget
- Environment variables are in .env file