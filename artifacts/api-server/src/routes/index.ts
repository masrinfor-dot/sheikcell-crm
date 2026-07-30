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
import settingsRouter from "./settings";
import partnerLinksRouter from "./partnerLinks";
import filmCompatRouter from "./filmCompat";
import tradeInRouter from "./tradeIn";
import checklistsRouter, { enforceMandatoryChecklists } from "./checklists";
import trainingsRouter, { enforceMandatoryTrainings } from "./trainings";
import sheetLinksRouter from "./sheetLinks";
import rhRouter from "./rh";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
// Trava o sistema (423) enquanto houver questionário/treinamento obrigatório pendente.
router.use(enforceMandatoryChecklists);
router.use(enforceMandatoryTrainings);
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
router.use(settingsRouter);
router.use(partnerLinksRouter);
router.use(filmCompatRouter);
router.use(tradeInRouter);
router.use(checklistsRouter);
router.use(trainingsRouter);
router.use(sheetLinksRouter);
router.use(rhRouter);

export default router;
