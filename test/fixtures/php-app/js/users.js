// Legacy jQuery search box
$(function () {
  $('#user-search').on('input', function () {
    var q = $(this).val();
    $.getJSON('/api/users_search.php', { q: q }, function (data) {
      var tbody = $('#users-table tbody');
      tbody.empty();
      $.each(data.results, function (i, u) {
        tbody.append('<tr><td>' + u.name + '</td><td>' + u.email + '</td></tr>');
      });
    });
  });
});
