/**
 * The foundation's own checks.
 *
 * These are the rules both apps depend on: what an outlet is, how long a shift
 * was, who was expected in, when a shop was open. They run without a database,
 * so they are quick enough to sit in the build.
 */
import './foundation.test';
import './portal.test';
import './workload.test';
import './punctuality.test';
