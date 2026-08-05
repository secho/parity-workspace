-- parity_capture.Invocation — the record of what the estate actually did.
-- Schema per SPEC §3, plus the fields M2-M5 turned out to need.
--
-- Three different clocks live in this table and they must not be confused:
--
--   CalledAt      the SIMULATED time the call is pretended to have happened, supplied by
--                 the traffic generator so one run yields 90 days of history.
--   RealCalledAt  the wall clock when the call really executed.
--   Context.getdate   what GETDATE() actually returned INSIDE the procedure's session.
--
-- The third is the load-bearing one. Eleven of the fourteen procedures read the ambient
-- clock and four of them BRANCH on it — sp_CalculateOrderTotal line 123 and
-- sp_ApplyPromoCode line 65 both test promo validity against wall-clock time. Replaying
-- such a call without pinning the clock lands in a different promo-validity regime and
-- reports a behaviour change that never happened. Since GETDATE() cannot be overridden
-- inside T-SQL without editing the estate, the pin has to happen in the replacement
-- service's injected clock — which is only possible if the value was recorded here.

USE ParityShop;
GO

CREATE SCHEMA parity_capture;
GO

CREATE TABLE parity_capture.Invocation (
    InvocationID    BIGINT IDENTITY(1,1) NOT NULL,
    ProcName        NVARCHAR(128)  NOT NULL,
    CalledAt        DATETIME2(3)   NOT NULL,   -- simulated timeline
    RealCalledAt    DATETIME2(3)   NOT NULL,   -- wall clock
    InputParams     NVARCHAR(MAX)  NULL,       -- json
    ResultSetHash   CHAR(64)       NULL,       -- sha256 over the canonicalised result
    ResultSet       NVARCHAR(MAX)  NULL,       -- json, sampled calls only
    WriteSet        NVARCHAR(MAX)  NULL,       -- json, sampled calls only:
                                               -- { table: [{ pk, column, before, after }] }
    Context         NVARCHAR(MAX)  NULL,       -- json: ambient values the procedure could read
    DurationMs      INT            NOT NULL,
    RowsAffected    INT            NULL,
    CallerContext   NVARCHAR(200)  NULL,       -- route / caller
    SessionID       NVARCHAR(40)   NULL,       -- groups a browse -> cart -> order session
    BranchKey       NVARCHAR(200)  NULL,       -- coverage proxy, see capture/sampler.ts
    Sampled         BIT            NOT NULL,   -- was the full payload captured
    CONSTRAINT PK_Invocation PRIMARY KEY CLUSTERED (InvocationID)
);
GO

CREATE INDEX IX_Invocation_Proc      ON parity_capture.Invocation (ProcName, CalledAt);
CREATE INDEX IX_Invocation_CalledAt  ON parity_capture.Invocation (CalledAt);
CREATE INDEX IX_Invocation_Session   ON parity_capture.Invocation (SessionID, CalledAt);
CREATE INDEX IX_Invocation_Branch    ON parity_capture.Invocation (ProcName, BranchKey);
GO
