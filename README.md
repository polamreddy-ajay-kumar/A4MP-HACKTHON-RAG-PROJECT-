# A4MP RAG SYSTEMS
A4MP = Artificial Intelligence Fourth Mind Platform. This is its document question-answering (RAG) component.

## Run
    node --no-warnings server/server.js     (needs Node.js 22.5 or newer)
Open http://localhost:5000  - the server banner and every page show "A4MP RAG SYSTEMS".

First-run admin login: admin@a4mp.com / Admin@123 (change it). Register normal users from the login page.
Sample documents for testing are in docs/.

## Notes
- This runnable build uses Node built-ins and SQLite (no npm install needed). The report's code listings use Express + MySQL; the routes, roles, tables and RAG logic are the same.
- Set LLM_API_KEY (and LLM_MODEL) to use an LLM for answers; without it the app answers offline from the best-matching sentences.
