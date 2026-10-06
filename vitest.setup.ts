// Loads backend/.env (when present) so tests and CLI-adjacent runs see the
// same environment as `npm run dev`. Missing file is fine — required
// variables are still validated with legible errors at boot/test time.
import 'dotenv/config';
