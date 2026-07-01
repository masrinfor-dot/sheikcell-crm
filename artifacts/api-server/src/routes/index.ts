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
import whatsappProxyRouter from "./whatsapp";
import internalChatRouter from "./internalChat";
import tasksRouter from "./tasks";

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
router.use(whatsappProxyRouter);
router.use(internalChatRouter);
router.use(tasksRouter);

export default router;
