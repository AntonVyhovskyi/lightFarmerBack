
import express from 'express';
import dotenv from 'dotenv';
import routes from "./routes";

import cors from 'cors';


dotenv.config();



const app = express();
app.use(express.json());
app.use(cors());

app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(200).json({ ok: false, error: "Invalid JSON body", message: err.message });
  }
  next(err);
});

app.use("/api", routes)



 
const port = Number(process.env.PORT) || 8080;
app.listen(port, "0.0.0.0", () => {
  console.log(`Server is running on 0.0.0.0:${port}`);
});