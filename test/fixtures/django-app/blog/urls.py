"""Blog URL patterns."""
from django.urls import path

from . import views

urlpatterns = [
    path("", views.post_list, name="post_list"),
    path("posts/<int:pk>/", views.post_detail, name="post_detail"),
]
