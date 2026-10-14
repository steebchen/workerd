using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [ (name = "main", worker = .main), (name = "tail", worker = .tail) ],
  sockets = [ (name = "http", address = "*:8080", http = (), service = "main") ]
);
const main :Workerd.Worker = (
  modules = [ (name = "main.js", esModule = embed "main.js") ],
  compatibilityDate = "2025-09-15",
  bindings = [ (name = "loader", workerLoader = ()), (name = "tail", service = "tail") ],
  tails = [ "tail" ]
);
const tail :Workerd.Worker = (
  modules = [ (name = "tail.js", esModule = embed "tail.js") ],
  compatibilityDate = "2025-09-15"
);
