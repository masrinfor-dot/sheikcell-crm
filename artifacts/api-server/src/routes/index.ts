import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import sectorsRouter from "./sectors";
import queueRouter from "./queue";
import adminRouter from "./admin";
import webhookRouter from "./webhook";
import crmRouter from "./crm";
import chatRouter from "./chat";
import routingRouter from "./routing";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(sectorsRouter);
router.use(queueRouter);
router.use(adminRouter);
router.use(webhookRouter);
router.use(crmRouter);
router.use(chatRouter);
router.use(routingRouter);

export default router;
