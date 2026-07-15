import { Router } from "express";
import { createMeasurementFacade, measurementRequestSchema } from "../services/measurement.js";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess } from "./authz.js";
import { HttpError } from "../errors.js";

/** Read-only measurement gateway. Google credentials never cross this HTTP boundary. */
export function measurementRoutes() {
  const router = Router();
  const facade = createMeasurementFacade();

  router.post("/companies/:companyId/measurement/query", validate(measurementRequestSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "agent") {
      res.status(403).json({ error: "Agent authentication is required for measurement queries" });
      return;
    }
    const controller = new AbortController();
    req.once("aborted", () => controller.abort());
    try {
      const result = await facade.query(companyId, req.body, controller.signal);
      res.json(result);
    } catch {
      // Configuration and provider details are deployment-only; fail closed without exposing either.
      throw new HttpError(503, "Measurement is unavailable");
    }
  });
  return router;
}
